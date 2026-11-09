const express = require('express');
const multer = require('multer');
const { createHash } = require('node:crypto');
const { getUscisOverview, listUscisEmployers, parseUscisFile, importUscisRows, STATE_ID } = require('../services/uscisH1b');

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 64 * 1024 * 1024, files: 1 } });

function createUscisRoutes({ db, authMiddleware }) {
    const router = express.Router();
    const respond = load => async (req, res) => {
        try {
            res.set('Cache-Control', 'public, max-age=300').json(await load(db(), req.query));
        } catch (error) {
            const status = error.status || 503;
            if (status >= 500) console.error('USCIS H-1B data failed:', error.message);
            res.status(status).set('Cache-Control', 'no-store').json({ error: status === 400 ? error.message : 'USCIS approval data is temporarily unavailable. Please try again.' });
        }
    };
    router.get('/', respond(getUscisOverview));
    router.get('/employers', respond(listUscisEmployers));

    // An H-1B Employer Data Hub export (one or more complete fiscal years). The
    // file is checked before replying; the import then runs in the background.
    let running = false;
    router.post('/import', authMiddleware, upload.single('file'), async (req, res) => {
        if (!req.file) return res.status(400).json({ error: 'Choose a USCIS H-1B Employer Data Hub file.' });
        if (running) return res.status(409).json({ error: 'A USCIS import is already running.' });
        let parsed;
        try { parsed = parseUscisFile(req.file.buffer); } catch (error) { return res.status(error.status || 400).json({ error: error.message }); }
        const source = { name: req.file.originalname.slice(0, 200), url: null, official: false, uploaded: true,
            sha256: createHash('sha256').update(req.file.buffer).digest('hex'), format: parsed.format };
        const years = [...new Set(parsed.rows.map(row => row.fiscalYear))].sort();
        const state = db().collection('discovery_state');
        const setJob = job => state.updateOne({ _id: STATE_ID }, { $set: { job: { ...job, file: source.name, years, updatedAt: new Date() } } }, { upsert: true }).catch(() => {});
        running = true;
        await setJob({ state: 'importing', phase: 'Saving rows', startedAt: new Date() });
        res.status(202).json({ accepted: true, rows: parsed.rows.length, years, format: parsed.format });
        const startedAt = new Date();
        importUscisRows(db(), parsed.rows, { source, allowSmaller: req.body?.allowSmaller === 'true', onProgress: event => {
            if (event.event === 'uscis-employers') return setJob({ state: 'importing', phase: 'Linking employer names', startedAt });
            return undefined;
        } })
            .then(() => setJob({ state: 'ready', startedAt, finishedAt: new Date(), rows: parsed.rows.length }))
            .catch(error => { console.error('USCIS import failed:', error.message); return setJob({ state: 'failed', startedAt, finishedAt: new Date(), error: error.message.slice(0, 500) }); })
            .finally(() => { running = false; });
    });
    return router;
}
module.exports = { createUscisRoutes };
