const express = require('express');
const router = express.Router();
const Case = require('../models/Case');
const PermCase = require('../models/PermCase');
const { authMiddleware } = require('./admin');
const mongoose = require('mongoose');
const { acquireImportLock } = require('../services/importLock');
const { invalidateCache } = require('./search');

router.get('/:id', async (req, res) => {
    try {
        let caseItem = await Case.findById(req.params.id);

        if (!caseItem) {
            caseItem = await PermCase.findById(req.params.id);
        }

        if (!caseItem) {
            return res.status(404).json({ error: 'Case not found' });
        }
        res.json(caseItem);
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
        if (!['pwd', 'perm'].includes(type)) return res.status(400).json({ error: 'Invalid case type' });
        lease = await acquireImportLock(mongoose.connection.db, 'Clear case data');
        const Model = type === 'perm' ? PermCase : Case;
        // A future automatic run must restore files even when their bytes have
        // not changed, since the administrator deliberately cleared this data.
        await mongoose.connection.db.collection('import_sources').updateMany({ type }, { $set: { status: 'cleared' } });
        const result = await Model.deleteMany({});
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
