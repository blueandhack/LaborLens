const express = require('express');
const multer = require('multer');
const fs = require('fs/promises');
const mongoose = require('mongoose');
const Case = require('../models/Case');
const PermCase = require('../models/PermCase');
const { authMiddleware } = require('./admin');
const { importWorkbook, VALIDATION_VERSION } = require('../services/importWorkbook');
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
        const [runs, sources, active, catalog] = await Promise.all([
            db.collection('import_runs').find({}).sort({ startedAt: -1 }).limit(5).toArray(),
            db.collection('import_sources').find({}, { projection: {
                url: 1, filename: 1, type: 1, fiscalYear: 1, status: 1, outcome: 1, error: 1,
                startedAt: 1, checkedAt: 1, completedAt: 1, runId: 1, progress: 1, validationProgress: 1,
                'validation.version': 1, 'validation.rows': 1, 'validation.uniqueCases': 1,
                'validation.duplicateRows': 1, 'validation.rejectedRows': 1, 'validation.issues': 1,
            } }).sort({ fiscalYear: -1, type: 1 }).limit(200).toArray(),
            db.collection('import_locks').findOne({ _id: 'case-import', expiresAt: { $gt: new Date() } }, { projection: { owner: 0 } }),
            db.collection('import_catalog').findOne({ _id: 'dol' }),
        ]);
        // A killed process cannot finish its history entry; report it honestly
        // once its lease has expired rather than displaying "running" forever.
        for (const run of runs) {
            if (run.status === 'running' && run._id !== active?.runId) run.status = 'interrupted';
        }
        for (const source of sources) {
            if (['downloading', 'validating', 'importing'].includes(source.status) && source.runId !== active?.runId) source.status = 'interrupted';
        }
        const urls = new Set(catalog?.datasets.map(dataset => dataset.url));
        const complete = sources.filter(source => urls.has(source.url) && source.status === 'done' && source.validation?.version === VALIDATION_VERSION);
        res.json({ runs, sources, active, coverage: catalog ? {
            availableFiles: catalog.datasets.length, completedFiles: complete.length,
            fromYear: catalog.fromYear, unavailable: catalog.unavailable,
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
        if (!['pwd', 'perm'].includes(type)) throw Object.assign(new Error('Import type must be pwd or perm'), { status: 400 });
        lease = await acquireImportLock(mongoose.connection.db, `Manual ${type.toUpperCase()} import`);
    } catch (error) {
        await fs.rm(filePath, { force: true });
        return res.status(error.status || 500).json({ error: error.status ? error.message : 'Unable to start import' });
    }
    currentJob = { status: 'starting', processed: 0, total: 0, inserted: 0, updated: 0,
        logs: ['File accepted. Starting import stream...'], message: 'Starting import stream...' };
    res.status(202).json({ message: 'File accepted. Beginning background processing.' });
    (async () => {
        try {
            const stats = await importWorkbook(filePath, {
                type, Model: type === 'perm' ? PermCase : Case, ensureActive: lease.ensureActive,
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
            refreshGlobalInsights(type === 'perm' ? PermCase : Case, type)
                .catch(error => console.error('Insights refresh failed:', error.message));
        }
    })().catch(error => console.error('Import cleanup failed:', error));
});

module.exports = router;
