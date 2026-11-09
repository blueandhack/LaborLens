const express = require('express');
const multer = require('multer');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const { getUscisOverview, listUscisEmployers, parseUscisFile, parseUscisStream, importUscisRows, STATE_ID } = require('../services/uscisH1b');

// A year of the hub's long CSV is about 100 MB, so uploads go to disk and are read as a stream.
const upload = multer({ dest: '/tmp/uscis_uploads/', limits: { fileSize: 256 * 1024 * 1024, files: 1 } });

async function readUpload(file) {
    const hash = createHash('sha256');
    await new Promise((resolve, reject) => fs.createReadStream(file.path).on('data', chunk => hash.update(chunk)).on('end', resolve).on('error', reject));
    const head = Buffer.alloc(2);
    const handle = await fs.promises.open(file.path, 'r');
    try { await handle.read(head, 0, 2, 0); } finally { await handle.close(); }
    // Tableau crosstab downloads are UTF-16 and small; everything else is read line by line.
    const parsed = head[0] === 0xff && head[1] === 0xfe ? parseUscisFile(await fs.promises.readFile(file.path)) : await parseUscisStream(fs.createReadStream(file.path));
    return { parsed, sha256: hash.digest('hex') };
}

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
        if (running) { fs.promises.unlink(req.file.path).catch(() => {}); return res.status(409).json({ error: 'A USCIS import is already running.' }); }
        running = true;
        let parsed, sha256;
        try { ({ parsed, sha256 } = await readUpload(req.file)); } catch (error) { running = false; return res.status(error.status || 400).json({ error: error.message }); }
        finally { fs.promises.unlink(req.file.path).catch(() => {}); }
        const source = { name: req.file.originalname.slice(0, 200), url: null, official: false, uploaded: true, sha256, format: parsed.format };
        const years = [...new Set(parsed.rows.map(row => row.fiscalYear))].sort();
        const state = db().collection('discovery_state');
        const setJob = job => state.updateOne({ _id: STATE_ID }, { $set: { job: { ...job, file: source.name, years, updatedAt: new Date() } } }, { upsert: true }).catch(() => {});
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
