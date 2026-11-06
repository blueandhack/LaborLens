const express = require('express');
const multer = require('multer');
const fs = require('fs/promises');
const mongoose = require('mongoose');
const Case = require('../models/Case');
const PermCase = require('../models/PermCase');
const { authMiddleware } = require('./admin');
const { importWorkbook } = require('../services/importWorkbook');
const { acquireImportLock } = require('../services/importLock');
const { invalidateCache } = require('./search');

const router = express.Router();
const upload = multer({ dest: '/tmp/pwd_uploads/', limits: { fileSize: 768 * 1024 * 1024 } });
let currentJob = { status: 'idle', processed: 0, total: 0, inserted: 0, updated: 0, logs: [], message: '' };

router.get('/status', authMiddleware, (req, res) => res.json(currentJob));

router.get('/auto/status', authMiddleware, async (req, res) => {
    try {
        const db = mongoose.connection.db;
        const [runs, sources, active] = await Promise.all([
            db.collection('import_runs').find({}).sort({ startedAt: -1 }).limit(5).toArray(),
            db.collection('import_sources').find({}).sort({ startedAt: -1 }).limit(10).toArray(),
            db.collection('import_locks').findOne({ _id: 'case-import', expiresAt: { $gt: new Date() } }, { projection: { owner: 0 } }),
        ]);
        // A killed process cannot finish its history entry; report it honestly
        // once its lease has expired rather than displaying "running" forever.
        for (const run of runs) {
            if (run.status === 'running' && run._id !== active?.runId) run.status = 'interrupted';
        }
        for (const source of sources) {
            if (['downloading', 'importing'].includes(source.status) && source.runId !== active?.runId) source.status = 'interrupted';
        }
        res.json({ runs, sources, active });
    } catch (error) {
        res.status(500).json({ error: 'Unable to read automatic import status' });
    }
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
            invalidateCache();
            try { await fs.rm(filePath, { force: true }); }
            finally { await lease.release(); }
        }
    })().catch(error => console.error('Import cleanup failed:', error));
});

module.exports = router;
