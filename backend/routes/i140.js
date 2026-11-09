const express = require('express');
const { getI140 } = require('../services/i140');

function createI140Routes({ db }) {
    const router = express.Router();
    router.get('/', async (_req, res) => {
        try {
            res.set('Cache-Control', 'public, max-age=600').json(await getI140(db()));
        } catch (error) {
            console.error('I-140 statistics failed:', error.message);
            res.status(503).set('Cache-Control', 'no-store').json({ error: 'I-140 statistics are temporarily unavailable. Please try again.' });
        }
    });
    return router;
}
module.exports = { createI140Routes };
