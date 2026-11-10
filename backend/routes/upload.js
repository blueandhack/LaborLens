const express = require('express');
const multer = require('multer');
const fs = require('fs/promises');
const mongoose = require('mongoose');
const models = require('../models/programModels');
const { authMiddleware } = require('./admin');
const { recordAdminEvent } = require('../services/adminEvents');
const { importWorkbook, VALIDATION_VERSION } = require('../services/importWorkbook');
const { buildImportCoverage, normalizedSources } = require('../services/importCoverage');
const { acquireImportLock } = require('../services/importLock');
const { invalidateCache } = require('./search');
const { noteInsightsChange, refreshGlobalInsights } = require('../services/searchInsights');

const router = express.Router();
const upload = multer({ dest: '/tmp/pwd_uploads/', limits: { fileSize: 768 * 1024 * 1024 } });
let currentJob = { status: 'idle', processed: 0, total: 0, inserted: 0, updated: 0, logs: [], message: '' };

router.get('/status', authMiddleware, (req, res) => res.json(currentJob));

router.get('/auto/status', authMiddleware, async (req, res) => {
    try {
        const db = mongoose.connection.db;
        const [runs, rawSources, active, catalog] = await Promise.all([
            db.collection('import_runs').find({}).sort({ startedAt: -1 }).limit(5).toArray(),
            db.collection('import_sources').find({}, { projection: {
                url: 1, filename: 1, type: 1, fiscalYear: 1, quarter: 1, status: 1, outcome: 1, error: 1,
                startedAt: 1, checkedAt: 1, completedAt: 1, runId: 1, progress: 1, validationProgress: 1,
                'validation.canImport': 1, 'validation.version': 1, 'validation.rows': 1, 'validation.uniqueCases': 1,
                'validation.resolvedIssues': 1, 'validation.duplicateRows': 1, 'validation.rejectedRows': 1, 'validation.issues': 1,
            } }).sort({ fiscalYear: -1, type: 1, quarter: -1 }).toArray(),
            db.collection('import_locks').findOne({ _id: 'case-import', expiresAt: { $gt: new Date() } }, { projection: { owner: 0 } }),
            db.collection('import_catalog').findOne({ _id: 'dol' }),
        ]);
        // A killed process cannot finish its history entry; report it honestly
        // once its lease has expired rather than displaying "running" forever.
        for (const run of runs) {
            if (run.status === 'running' && run._id !== active?.runId) run.status = 'interrupted';
        }
        const sources = normalizedSources(rawSources, active);
        const currentRun = active?.runId ? runs.find(run => run._id === active.runId) || await db.collection('import_runs').findOne({ _id: active.runId }, { projection: { results: 0 } }) : null;
        const progress = buildImportCoverage({ catalog, sources, active, validationVersion: VALIDATION_VERSION });
        const known = progress.programs.filter(program => program.inventoryKnown);
        res.json({ runs, currentRun, sources, active, progress, coverage: catalog ? {
            availableFiles: known.reduce((sum, program) => sum + program.totalFiles, 0),
            completedFiles: known.reduce((sum, program) => sum + program.completedFiles, 0),
            fromYear: progress.fromYear, unavailable: catalog.unavailable,
        } : null });
    } catch (error) {
        res.status(500).json({ error: 'Unable to read automatic import status' });
    }
});

router.get('/auto/report/:id', authMiddleware, async (req, res) => {
    try {
        const source = await mongoose.connection.db.collection('import_sources').findOne({ _id: req.params.id }, {
            projection: { filename: 1, url: 1, fiscalYear: 1, type: 1, sha256: 1, validation: 1, progress: 1 },
        });
        if (!source) return res.status(404).json({ error: 'Import source not found' });
        res.json(source);
    } catch (error) { res.status(500).json({ error: 'Unable to read validation report' }); }
});

router.post('/', authMiddleware, upload.single('file'), async (req, res) => {
    const filePath = req.file?.path;
    if (!filePath) return res.status(400).json({ error: 'No file uploaded' });
    const type = req.body.type || 'pwd';
    let lease;
    try {
        if (typeof type !== 'string' || !Object.hasOwn(models, type)) throw Object.assign(new Error('Import type must be pwd, perm or h1b'), { status: 400 });
        lease = await acquireImportLock(mongoose.connection.db, `Manual ${type.toUpperCase()} import`);
    } catch (error) {
        await fs.rm(filePath, { force: true });
        return res.status(error.status || 500).json({ error: error.status ? error.message : 'Unable to start import' });
    }
    currentJob = { status: 'starting', processed: 0, total: 0, inserted: 0, updated: 0,
        logs: ['File accepted. Starting import stream...'], message: 'Starting import stream...' };
    recordAdminEvent(mongoose.connection.db, 'upload', req, { username: req.adminUsername, program: type, filename: String(req.file.originalname || '').slice(0, 160), bytes: req.file.size });
    res.status(202).json({ message: 'File accepted. Beginning background processing.' });
    (async () => {
        try {
            const stats = await importWorkbook(filePath, {
                type, Model: models[type], ensureActive: lease.ensureActive,
                onValidated: async report => {
                    currentJob.total = report.uniqueCases;
                    currentJob.logs.push(`Validated ${report.rows} rows, ${report.uniqueCases} unique cases, ${report.duplicateRows} duplicate rows.`);
                },
                onProgress: async progress => Object.assign(currentJob, progress, { status: 'progress' }),
            });
            Object.assign(currentJob, stats, { total: stats.processed, status: 'done', message: 'Import complete!' });
            currentJob.logs.push(`Finished! Inserted: ${stats.inserted}, Updated: ${stats.updated}, Total Processed: ${stats.processed}`);
        } catch (error) {
            console.error('Background import failed:', error);
            currentJob.status = 'error';
            currentJob.message = error.message;
            currentJob.logs.push(`Error: ${error.message}`);
        } finally {
            // Partial writes also change search results; invalidate on failure.
            try { await noteInsightsChange(mongoose.connection.db, type); }
            catch (error) { console.error('Insights invalidation failed:', error.message); }
            invalidateCache();
            try { await fs.rm(filePath, { force: true }); }
            finally { await lease.release(); }
            refreshGlobalInsights(models[type], type)
                .catch(error => console.error('Insights refresh failed:', error.message));
        }
    })().catch(error => console.error('Import cleanup failed:', error));
});

module.exports = router;
