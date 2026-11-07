const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const { createHash, randomUUID } = require('crypto');
const { fetchDatasetInventory, downloadDataset } = require('./dolSource');
const { importWorkbook, auditWorkbook, VALIDATION_VERSION, sourceRank } = require('./importWorkbook');
const { acquireImportLock } = require('./importLock');
const SOURCE_REVIEW_VERSION = 3;
const { noteInsightsChange } = require('./searchInsights');

async function runAutoImport(db, {
    models, programs = Object.keys(models), force = false, signal, fromYear, maxFiles = Infinity, backfill = false,
    discover = fetchDatasetInventory, download = downloadDataset, importFile = importWorkbook, auditFile = auditWorkbook,
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
        const discovered = await discover({ fromYear, programs, signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(60000)]) : undefined });
        const datasets = Array.isArray(discovered) ? discovered : discovered.datasets;
        const releases = Array.isArray(discovered) ? null : discovered.releases;
        const latest = Object.fromEntries(programs.map(type => [type, Math.max(...datasets.filter(file => file.type === type).map(sourceRank))]));
        if (fromYear !== undefined) datasets.sort((a, b) => (backfill ? 1 : -1) * (sourceRank(a) - sourceRank(b)) || a.type.localeCompare(b.type));
        const unavailable = [];
        if (fromYear !== undefined) {
            for (const type of programs) {
                const years = new Set(datasets.filter(file => file.type === type).map(file => file.fiscalYear));
                for (let year = fromYear; year <= Math.max(...years); year++) if (!years.has(year)) unavailable.push({ type, fiscalYear: year });
            }
            const previousCatalog = await db.collection('import_catalog').findOne({ _id: 'dol' });
            const retainedDatasets = (previousCatalog?.datasets || []).filter(file => !programs.includes(file.type));
            const retainedUnavailable = (previousCatalog?.unavailable || []).filter(file => !programs.includes(file.type));
            await db.collection('import_catalog').updateOne({ _id: 'dol' }, { $set: {
                datasets: [...retainedDatasets, ...datasets], unavailable: [...retainedUnavailable, ...unavailable],
                fromYear: Math.min(fromYear, previousCatalog?.fromYear ?? fromYear), checkedAt: new Date(),
            } }, { upsert: true });
        }
        if (releases) {
            const previous = await db.collection('import_catalog').findOne({ _id: 'dol' });
            await db.collection('import_catalog').updateOne({ _id: 'dol' }, { $set: {
                releases: [...(previous?.releases || []).filter(file => !programs.includes(file.type)), ...releases],
                releasesCheckedAt: new Date(),
            } }, { upsert: true });
        }
        log({ event: 'discovered', datasets });
        for (const dataset of datasets) {
            ensureActive();
            const sourceId = createHash('sha256').update(dataset.url).digest('hex');
            const previous = await sources.findOne({ _id: sourceId });
            if (backfill && !force && previous?.status === 'blocked' && previous.reviewVersion === SOURCE_REVIEW_VERSION) {
                results.push({ ...dataset, outcome: 'source-review-required', error: previous.error });
                continue;
            }
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
            let writesStarted = false;
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
                    await sources.updateOne({ _id: sourceId }, { $set: { status: 'validating', attemptedSha256: downloaded.sha256, progress: { processed: 0 }, validationProgress: { rows: 0 } } });
                    const validation = await auditFile(destination, {
                        type: dataset.type, source: { ...dataset, sha256: downloaded.sha256 }, ensureActive,
                        onProgress: async progress => {
                            ensureActive();
                            await sources.updateOne({ _id: sourceId }, { $set: { validationProgress: progress } });
                        },
                    });
                    validation.report.sha256 = downloaded.sha256;
                    await sources.updateOne({ _id: sourceId }, { $set: { validation: validation.report, status: 'importing' } });
                    if (!validation.report.canImport) throw new Error(`Validation rejected ${validation.report.rejectedRows} rows without case numbers; file not imported`);
                    writesStarted = true;
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
                await sources.updateOne({ _id: sourceId }, { $set: { status: error.code === 'SOURCE_REVIEW_REQUIRED' ? 'blocked' : 'error', error: error.message, checkedAt: new Date(), ...(error.code === 'SOURCE_REVIEW_REQUIRED' ? { reviewVersion: SOURCE_REVIEW_VERSION } : {}), ...(error.report ? { validation: error.report } : {}) } });
                results.push({ ...dataset, outcome: 'error', error: error.message });
                errors.push(`${dataset.filename}: ${error.message}`);
                log({ event: 'file-failed', filename: dataset.filename, error: error.message });
            } finally {
                if (writesStarted) {
                    try { await noteInsightsChange(db, dataset.type); }
                    catch (error) { log({ event: 'insights-invalidation-failed', error: error.message }); }
                }
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
