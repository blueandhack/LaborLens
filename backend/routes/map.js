const express = require('express');
const { getMap, getMapOptions, getLocalMap } = require('../services/map');

function createMapRoutes({ db }) {
    const router = express.Router();
    const respond = load => async (req, res) => {
        try {
            res.set('Cache-Control', 'public, max-age=300').json(await load(db(), req.query));
        } catch (error) {
            const status = error.status || 503;
            if (status >= 500) console.error('Map failed:', error.message);
            res.status(status).set('Cache-Control', 'no-store').json({ error: status === 400 ? error.message : 'The map is temporarily unavailable. You can still search cases.' });
        }
    };
    router.get('/', respond(getMap));
    router.get('/options', respond(getMapOptions));
    router.get('/local', respond(getLocalMap));
    return router;
}
module.exports = { createMapRoutes };
