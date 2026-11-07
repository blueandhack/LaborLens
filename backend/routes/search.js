const express = require('express');
const router = express.Router();
const Case = require('../models/Case');
const PermCase = require('../models/PermCase');
const { getAvailableYears } = require('../services/searchYears');
const { searchCases, invalidateCounts } = require('../services/caseSearch');
const { programs } = require('../services/searchConfig');
const { BoundedCache } = require('../services/boundedCache');

const years = new BoundedCache({ capacity: 2, ttlMs: 10 * 60 * 1000 });
const invalidateCache = () => { years.clear(); invalidateCounts(); };

function searchHandler(Model, program) {
    return async (req, res) => {
        const controller = new AbortController();
        const disconnect = () => { if (!res.writableEnded) controller.abort(); };
        res.once('close', disconnect);
        try {
            const result = await searchCases(Model, program, req.query, { signal: controller.signal });
            // Public records only. Brief browser caching makes back navigation cheap.
            if (!controller.signal.aborted) res.set('Cache-Control', 'public, max-age=15').json(result);
        } catch (error) {
            if (controller.signal.aborted) return;
            const status = error.status || (error.code === 50 || error.name === 'MongoWaitQueueTimeoutError' ? 503 : 500);
            if (status >= 500) console.error(`${program.toUpperCase()} search failed:`, error.message);
            res.status(status).json({ error: status === 400 ? error.message : status === 503
                ? 'This search is taking too long. Add a company, date, or case number to narrow it.'
                : 'An error occurred while searching' });
        } finally { res.removeListener('close', disconnect); }
    };
}

function yearsHandler(Model, program) {
    return async (_req, res) => {
        try {
            const config = programs[program];
            const result = await years.get(program, () => getAvailableYears(Model, [config.date, 'RECEIVED_DATE']));
            res.set('Cache-Control', 'public, max-age=300').json(result);
        } catch (error) {
            console.error('Year options failed:', error.message);
            res.status(500).json({ error: 'An error occurred while fetching years' });
        }
    };
}

router.get('/', searchHandler(Case, 'pwd'));
router.get('/years', yearsHandler(Case, 'pwd'));
router.get('/perm', searchHandler(PermCase, 'perm'));
router.get('/perm/years', yearsHandler(PermCase, 'perm'));
module.exports = { router, invalidateCache };
