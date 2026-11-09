const express = require('express');
const router = express.Router();
const models = require('../models/programModels');
const { getAvailableYears } = require('../services/searchYears');
const { searchCases, countCases, invalidateCounts } = require('../services/caseSearch');
const { programs } = require('../services/searchConfig');
const { BoundedCache } = require('../services/boundedCache');
const { getSearchInsights, invalidateInsights } = require('../services/searchInsights');

const years = new BoundedCache({ capacity: 3, ttlMs: 10 * 60 * 1000 });
const invalidateCache = () => { years.clear(); invalidateCounts(); invalidateInsights(); };

function insightsHandler(Model, program) {
    return async (req, res) => {
        const controller = new AbortController();
        const disconnect = () => { if (!res.writableEnded) controller.abort(); };
        res.once('close', disconnect);
        try {
            const result = await getSearchInsights(Model, program, req.query, { signal: controller.signal });
            if (!controller.signal.aborted) res.set('Cache-Control', 'public, max-age=15').json(result);
        } catch (error) {
            if (controller.signal.aborted) return;
            const status = error.status || ([50, 292, 4031700].includes(error.code) ? 503 : 500);
            if (status >= 500) console.error(`${program.toUpperCase()} insights failed:`, error.message);
            res.status(status).set('Cache-Control', 'no-store').json({ error: status === 400 ? error.message
                : 'Insights could not load. Try again, or narrow this search. Your case results are still available.' });
        } finally { res.removeListener('close', disconnect); }
    };
}

function searchHandler(Model, program, countOnly = false) {
    return async (req, res) => {
        const controller = new AbortController();
        const disconnect = () => { if (!res.writableEnded) controller.abort(); };
        res.once('close', disconnect);
        try {
            if (req.query.worksite || req.query.worksiteState) {
                const status = await Model.db.collection('discovery_state').findOne({ _id: 'worksites' }, { maxTimeMS: 1000 });
                if (!status?.programs?.[program]?.ready) return res.status(503).set('Cache-Control', 'no-store').json({ error: 'Worksite search is being prepared. You can still search employer locations.' });
            }
            const result = await (countOnly ? countCases : searchCases)(Model, program, req.query, { signal: controller.signal });
            // Public records only. Brief browser caching makes back navigation cheap.
            if (!controller.signal.aborted) res.set('Cache-Control', 'public, max-age=15').json(result);
        } catch (error) {
            if (controller.signal.aborted) return;
            const status = error.status || (error.code === 50 || error.name === 'MongoWaitQueueTimeoutError' ? 503 : 500);
            if (status >= 500) console.error(`${program.toUpperCase()} search failed:`, error.message);
            res.status(status).set('Cache-Control', 'no-store').json({ error: status === 400 ? error.message : countOnly
                ? 'The total could not be counted. Your case results are still available.' : status === 503
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

for (const [program, Model] of Object.entries(models)) {
    const prefix = program === 'pwd' ? '' : '/' + program;
    router.get(prefix || '/', searchHandler(Model, program));
    router.get(prefix + '/count', searchHandler(Model, program, true));
    router.get(prefix + '/years', yearsHandler(Model, program));
    router.get(prefix + '/insights', insightsHandler(Model, program));
}
module.exports = { router, invalidateCache };
