const express = require('express');
const router = express.Router();
const Case = require('../models/Case');
const PermCase = require('../models/PermCase');
const { authMiddleware } = require('./admin');

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
    try {
        const type = req.query.type || 'pwd';
        const Model = type === 'perm' ? PermCase : Case;
        const result = await Model.deleteMany({});
        res.json({ success: true, deletedCount: result.deletedCount, message: `Successfully deleted ${result.deletedCount} ${type.toUpperCase()} cases` });
    } catch (error) {
        console.error('Data clear error:', error);
        res.status(500).json({ error: 'Failed to clear cases data' });
    }
});

module.exports = router;
