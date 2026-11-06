const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const { createHash, randomUUID } = require('crypto');
const { fetchDatasets, downloadDataset } = require('./dolSource');
const { importWorkbook } = require('./importWorkbook');
const { acquireImportLock } = require('./importLock');

async function runAutoImport(db, {
    models, force = false, signal,
    discover = fetchDatasets, download = downloadDataset, importFile = importWorkbook,
    log = message => console.log(JSON.stringify({ time: new Date().toISOString(), ...message })),
} = {}) {
    const runs = db.collection('import_runs');
    const sources = db.collection('import_sources');
    const runId = randomUUID();
    let lease;
    let tempDir;
    const results = [];
    const errors = [];
    const ensureActive = () => { signal?.throwIfAborted(); lease.ensureActive(); };
    await runs.insertOne({ _id: runId, status: 'running', startedAt: new Date(), results: [] });
    try {
        lease = await acquireImportLock(db, 'DOL automatic import', { runId });
        tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'laborlens-dol-'));
        const datasets = await discover({ signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(60000)]) : undefined });
        log({ event: 'discovered', datasets });
        for (const dataset of datasets) {
            ensureActive();
            const sourceId = createHash('sha256').update(dataset.url).digest('hex');
            const previous = await sources.findOne({ _id: sourceId });
            const newer = await sources.findOne({
                type: dataset.type, completedAt: { $exists: true },
                $or: [{ fiscalYear: { $gt: dataset.fiscalYear } },
                    { fiscalYear: dataset.fiscalYear, quarter: { $gt: dataset.quarter } }],
            });
            if (newer) throw new Error(`Refusing to replace ${dataset.type.toUpperCase()} data with a superseded DOL release`);
            const destination = path.join(tempDir, sourceId + '.xlsx');
            await sources.updateOne({ _id: sourceId }, {
                $set: { ...dataset, status: 'downloading', runId, startedAt: new Date(), error: null },
                $inc: { attempts: 1 },
            }, { upsert: true });
            try {
                // After a failed/partial run, always replay the file rather than
                // accepting validators belonging to an earlier successful import.
                const imported = previous?.status === 'done' ? previous : null;
                const downloaded = await download(dataset, destination, imported, {
                    force, signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15 * 60 * 1000)]) : undefined,
                });
                ensureActive();
                if (downloaded.unchanged) {
                    const { unchanged, ...metadata } = downloaded;
                    await sources.updateOne({ _id: sourceId }, { $set: {
                        ...metadata, status: 'done', outcome: 'unchanged', checkedAt: new Date(),
                    } });
                    results.push({ ...dataset, outcome: 'unchanged' });
                    log({ event: 'unchanged', filename: dataset.filename });
                } else {
                    await sources.updateOne({ _id: sourceId }, { $set: { status: 'importing', progress: { processed: 0 } } });
                    const stats = await importFile(destination, {
                        type: dataset.type, Model: models[dataset.type], ensureActive,
                        onProgress: async progress => {
                            ensureActive();
                            await sources.updateOne({ _id: sourceId }, { $set: { progress } });
                            log({ event: 'progress', filename: dataset.filename, ...progress });
                        },
                    });
                    ensureActive();
                    await sources.updateOne({ _id: sourceId }, { $set: {
                        ...downloaded, status: 'done', outcome: 'imported', progress: stats,
                        completedAt: new Date(), checkedAt: new Date(),
                    } });
                    results.push({ ...dataset, outcome: 'imported', ...stats });
                    log({ event: 'imported', filename: dataset.filename, ...stats });
                }
            } catch (error) {
                await sources.updateOne({ _id: sourceId }, { $set: { status: 'error', error: error.message, checkedAt: new Date() } });
                results.push({ ...dataset, outcome: 'error', error: error.message });
                errors.push(`${dataset.filename}: ${error.message}`);
                log({ event: 'file-failed', filename: dataset.filename, error: error.message });
            } finally {
                await fs.rm(destination, { force: true });
            }
            await runs.updateOne({ _id: runId }, { $set: { results } });
        }
        if (errors.length) throw new Error(errors.join('; '));
        await runs.updateOne({ _id: runId }, { $set: { status: 'done', finishedAt: new Date(), results } });
        log({ event: 'complete', runId, results });
        return { runId, results };
    } catch (error) {
        await runs.updateOne({ _id: runId }, { $set: { status: 'error', error: error.message, finishedAt: new Date(), results } });
        throw error;
    } finally {
        try { if (tempDir) await fs.rm(tempDir, { recursive: true, force: true }); }
        finally { if (lease) await lease.release(); }
    }
}

module.exports = { runAutoImport };
