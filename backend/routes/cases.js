const express = require('express');
const router = express.Router();
const models = require('../models/programModels');
const { authMiddleware } = require('./admin');
const mongoose = require('mongoose');
const { acquireImportLock } = require('../services/importLock');
const { invalidateCache } = require('./search');
const { noteInsightsChange } = require('../services/searchInsights');
const { slugFor, clearEmployerProgram } = require('../services/employers');
const { programs } = require('../services/searchConfig');

router.get('/:id', async (req, res) => {
    try {
        if (!mongoose.isObjectIdOrHexString(req.params.id)) return res.status(404).json({ error: 'Case not found' });
        for (const [program, Model] of Object.entries(models)) {
            const item = await Model.findById(req.params.id).lean().maxTimeMS(5000);
            if (item) {
                const key = item[programs[program].company] || item[programs[program].employer]?.toLowerCase();
                return res.set('Cache-Control', 'public, max-age=60').json({ ...item, _PROGRAM: program, EMPLOYER_PROFILE_SLUG: key ? slugFor(key) : null });
            }
        }
        res.status(404).json({ error: 'Case not found' });
    } catch (error) {
        console.error('Case fetch error:', error);
        res.status(500).json({ error: 'Failed to fetch case details' });
    }
});

// Delete all cases endpoint
router.delete('/', authMiddleware, async (req, res) => {
    let lease;
    try {
        const type = req.query.type || 'pwd';
        if (typeof type !== 'string' || !Object.hasOwn(models, type)) return res.status(400).json({ error: 'Invalid case type' });
        lease = await acquireImportLock(mongoose.connection.db, 'Clear case data');
        const Model = models[type];
        // A future automatic run must restore files even when their bytes have
        // not changed, since the administrator deliberately cleared this data.
        await mongoose.connection.db.collection('import_sources').updateMany({ type }, { $set: { status: 'cleared' } });
        const result = await Model.deleteMany({});
        await noteInsightsChange(mongoose.connection.db, type, { clear: true });
        await clearEmployerProgram(mongoose.connection.db, type);
        invalidateCache();
        res.json({ success: true, deletedCount: result.deletedCount, message: `Successfully deleted ${result.deletedCount} ${type.toUpperCase()} cases` });
    } catch (error) {
        console.error('Data clear error:', error);
        res.status(error.status || 500).json({ error: error.status ? error.message : 'Failed to clear cases data' });
    } finally {
        if (lease) await lease.release();
    }
});

module.exports = router;
