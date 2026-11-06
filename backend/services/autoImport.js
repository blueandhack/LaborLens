const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const { createHash, randomUUID } = require('crypto');
const { fetchDatasets, downloadDataset } = require('./dolSource');
const { importWorkbook, auditWorkbook, VALIDATION_VERSION, sourceRank } = require('./importWorkbook');
const { acquireImportLock } = require('./importLock');

async function runAutoImport(db, {
    models, force = false, signal, fromYear, maxFiles = Infinity, backfill = false,
    discover = fetchDatasets, download = downloadDataset, importFile = importWorkbook, auditFile = auditWorkbook,
    log = message => console.log(JSON.stringify({ time: new Date().toISOString(), ...message })),
} = {}) {
    const runs = db.collection('import_runs');
    const sources = db.collection('import_sources');
    const runId = randomUUID();
    let lease;
    let tempDir;
    const results = [];
    const errors = [];
    let checkedFiles = 0;
    const ensureActive = () => { signal?.throwIfAborted(); lease.ensureActive(); };
    await runs.insertOne({ _id: runId, mode: backfill ? 'backfill' : 'refresh', fromYear, status: 'running', startedAt: new Date(), results: [] });
    try {
        lease = await acquireImportLock(db, backfill ? 'DOL historical backfill' : 'DOL automatic import', { runId });
        tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'laborlens-dol-'));
        const datasets = await discover({ fromYear, signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(60000)]) : undefined });
        const latest = Object.fromEntries(['pwd', 'perm'].map(type => [type, Math.max(...datasets.filter(file => file.type === type).map(sourceRank))]));
        if (fromYear !== undefined) datasets.sort((a, b) => (backfill ? 1 : -1) * (sourceRank(a) - sourceRank(b)) || a.type.localeCompare(b.type));
        const unavailable = [];
        if (fromYear !== undefined) {
            for (const type of ['pwd', 'perm']) {
                const years = new Set(datasets.filter(file => file.type === type).map(file => file.fiscalYear));
                for (let year = fromYear; year <= Math.max(...years); year++) if (!years.has(year)) unavailable.push({ type, fiscalYear: year });
            }
            await db.collection('import_catalog').updateOne({ _id: 'dol' }, { $set: {
                datasets, unavailable, fromYear, checkedAt: new Date(),
            } }, { upsert: true });
        }
        log({ event: 'discovered', datasets });
        for (const dataset of datasets) {
            ensureActive();
            const sourceId = createHash('sha256').update(dataset.url).digest('hex');
            const previous = await sources.findOne({ _id: sourceId });
            if (backfill && !force && previous?.status === 'done' && previous.validation?.version === VALIDATION_VERSION) {
                results.push({ ...dataset, outcome: 'already-imported' });
                continue;
            }
            if (checkedFiles >= maxFiles) break;
            const newer = await sources.findOne({
                type: dataset.type, completedAt: { $exists: true },
                $or: [{ fiscalYear: { $gt: dataset.fiscalYear } },
                    { fiscalYear: dataset.fiscalYear, quarter: { $gt: dataset.quarter } }],
            });
            if (newer && fromYear === undefined) throw new Error(`Refusing to replace ${dataset.type.toUpperCase()} data with a superseded DOL release`);
            const historical = fromYear !== undefined && (sourceRank(dataset) < latest[dataset.type] || !!newer);
            const destination = path.join(tempDir, sourceId + '.xlsx');
            await sources.updateOne({ _id: sourceId }, {
                $set: { ...dataset, status: 'downloading', runId, startedAt: new Date(), error: null },
                $inc: { attempts: 1 },
            }, { upsert: true });
            try {
                // After a failed/partial run, always replay the file rather than
                // accepting validators belonging to an earlier successful import.
                const imported = previous?.status === 'done' && previous.validation?.version === VALIDATION_VERSION ? previous : null;
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
                    checkedFiles++;
                    await sources.updateOne({ _id: sourceId }, { $set: { status: 'validating', attemptedSha256: downloaded.sha256, progress: { processed: 0 } } });
                    const validation = await auditFile(destination, {
                        type: dataset.type, ensureActive,
                        onProgress: async progress => {
                            ensureActive();
                            await sources.updateOne({ _id: sourceId }, { $set: { validationProgress: progress } });
                        },
                    });
                    validation.report.sha256 = downloaded.sha256;
                    await sources.updateOne({ _id: sourceId }, { $set: { validation: validation.report, status: 'importing' } });
                    if (!validation.report.canImport) throw new Error(`Validation rejected ${validation.report.rejectedRows} rows without case numbers; file not imported`);
                    const stats = await importFile(destination, {
                        type: dataset.type, Model: models[dataset.type], ensureActive, validation, historical,
                        source: { ...dataset, sha256: downloaded.sha256 },
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
                await sources.updateOne({ _id: sourceId }, { $set: { status: 'error', error: error.message, checkedAt: new Date(), ...(error.report ? { validation: error.report } : {}) } });
                results.push({ ...dataset, outcome: 'error', error: error.message });
                errors.push(`${dataset.filename}: ${error.message}`);
                log({ event: 'file-failed', filename: dataset.filename, error: error.message });
            } finally {
                await fs.rm(destination, { force: true });
            }
            await runs.updateOne({ _id: runId }, { $set: { results } });
        }
        if (errors.length) throw new Error(errors.join('; '));
        await runs.updateOne({ _id: runId }, { $set: { status: 'done', finishedAt: new Date(), results, checkedFiles } });
        log({ event: 'complete', runId, results });
        return { runId, results };
    } catch (error) {
        await runs.updateOne({ _id: runId }, { $set: { status: backfill && error.status === 409 ? 'busy' : 'error', error: error.message, finishedAt: new Date(), results } });
        if (backfill && error.status === 409) return { runId, results, busy: true };
        throw error;
    } finally {
        try { if (tempDir) await fs.rm(tempDir, { recursive: true, force: true }); }
        finally { if (lease) await lease.release(); }
    }
}

module.exports = { runAutoImport };
