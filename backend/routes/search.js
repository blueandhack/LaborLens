const express = require('express');
const router = express.Router();
const Case = require('../models/Case');
const PermCase = require('../models/PermCase');
router.get('/', async (req, res) => {
    try {
        const {
            company, location, caseNumber, jobTitle,
            determinationYear, receivedYear,
            page = 1, limit = 20
        } = req.query;

        let query = {};
        let sort = { DETERMINATION_DATE: -1, EMPLOYER_LEGAL_BUSINESS_NAME: 1 };

        const conditions = [];

        if (company && company.trim() !== '') {
            conditions.push({ EMPLOYER_LEGAL_BUSINESS_NAME: { $regex: company.trim(), $options: 'i' } });
        }

        if (location && location.trim() !== '') {
            const locRegex = { $regex: location.trim(), $options: 'i' };
            conditions.push({
                $or: [
                    { EMPLOYER_CITY: locRegex },
                    { EMPLOYER_STATE: locRegex }
                ]
            });
        }

        if (caseNumber && caseNumber.trim() !== '') {
            conditions.push({ CASE_NUMBER: { $regex: caseNumber.trim(), $options: 'i' } });
        }

        if (jobTitle && jobTitle.trim() !== '') {
            conditions.push({ JOB_TITLE: { $regex: jobTitle.trim(), $options: 'i' } });
        }

        if (determinationYear && !isNaN(parseInt(determinationYear))) {
            const year = parseInt(determinationYear);
            conditions.push({
                DETERMINATION_DATE: {
                    $gte: new Date(`${year}-01-01T00:00:00.000Z`),
                    $lte: new Date(`${year}-12-31T23:59:59.999Z`)
                }
            });
        }

        if (receivedYear && !isNaN(parseInt(receivedYear))) {
            const year = parseInt(receivedYear);
            conditions.push({
                RECEIVED_DATE: {
                    $gte: new Date(`${year}-01-01T00:00:00.000Z`),
                    $lte: new Date(`${year}-12-31T23:59:59.999Z`)
                }
            });
        }

        if (conditions.length > 0) {
            query = { $and: conditions };
        }

        const skip = (parseInt(page) - 1) * parseInt(limit);

        const cases = await Case.find(query)
            .sort(sort)
            .skip(skip)
            .limit(parseInt(limit));

        const totalCount = Object.keys(query).length === 0
            ? await Case.estimatedDocumentCount()
            : await Case.countDocuments(query);

        res.json({
            cases,
            totalPages: Math.ceil(totalCount / limit),
            currentPage: parseInt(page),
            totalCount
        });
    } catch (error) {
        console.error('Search API error:', error);
        res.status(500).json({ error: 'An error occurred while searching' });
    }
});

// Get available years for dropdowns
router.get('/years', async (req, res) => {
    try {
        const result = await Case.aggregate([
            {
                $group: {
                    _id: null,
                    minDet: { $min: "$DETERMINATION_DATE" },
                    maxDet: { $max: "$DETERMINATION_DATE" },
                    minRec: { $min: "$RECEIVED_DATE" },
                    maxRec: { $max: "$RECEIVED_DATE" }
                }
            }
        ]);

        if (!result || result.length === 0) {
            return res.json([]);
        }

        const stats = result[0];
        const years = new Set();

        // Helper to add year if valid
        const addYear = (dateField) => {
            if (dateField && dateField instanceof Date) {
                const y = dateField.getFullYear();
                if (y > 1900 && y < 2100) years.add(y); // Sanity check bound
            }
        };

        addYear(stats.minDet);
        addYear(stats.maxDet);
        addYear(stats.minRec);
        addYear(stats.maxRec);

        if (years.size === 0) {
            return res.json([]);
        }

        const minYear = Math.min(...Array.from(years));
        const maxYear = Math.max(...Array.from(years));

        const yearRange = [];
        for (let y = maxYear; y >= minYear; y--) {
            yearRange.push(y);
        }

        res.json(yearRange);
    } catch (error) {
        console.error('Get years API error:', error);
        res.status(500).json({ error: 'An error occurred while fetching years' });
    }
});

module.exports = router;

// --- PERM SEARCH ROUTES ---

router.get('/perm', async (req, res) => {
    try {
        const {
            company, location, caseNumber, jobTitle,
            decisionYear, receivedYear,
            page = 1, limit = 20
        } = req.query;

        let query = {};
        let sort = { DECISION_DATE: -1, EMP_BUSINESS_NAME: 1 };

        const conditions = [];

        if (company && company.trim() !== '') {
            conditions.push({ EMP_BUSINESS_NAME: { $regex: company.trim(), $options: 'i' } });
        }

        if (location && location.trim() !== '') {
            const locRegex = { $regex: location.trim(), $options: 'i' };
            conditions.push({
                $or: [
                    { EMP_CITY: locRegex },
                    { EMP_STATE: locRegex }
                ]
            });
        }

        if (caseNumber && caseNumber.trim() !== '') {
            conditions.push({ CASE_NUMBER: { $regex: caseNumber.trim(), $options: 'i' } });
        }

        if (jobTitle && jobTitle.trim() !== '') {
            conditions.push({ JOB_TITLE: { $regex: jobTitle.trim(), $options: 'i' } });
        }

        if (decisionYear && !isNaN(parseInt(decisionYear))) {
            const year = parseInt(decisionYear);
            conditions.push({
                DECISION_DATE: {
                    $gte: new Date(`${year}-01-01T00:00:00.000Z`),
                    $lte: new Date(`${year}-12-31T23:59:59.999Z`)
                }
            });
        }

        if (receivedYear && !isNaN(parseInt(receivedYear))) {
            const year = parseInt(receivedYear);
            conditions.push({
                RECEIVED_DATE: {
                    $gte: new Date(`${year}-01-01T00:00:00.000Z`),
                    $lte: new Date(`${year}-12-31T23:59:59.999Z`)
                }
            });
        }

        if (conditions.length > 0) {
            query = { $and: conditions };
        }

        const skip = (parseInt(page) - 1) * parseInt(limit);

        const results = await PermCase.aggregate([
            { $match: query },
            { $sort: sort },
            { $skip: skip },
            { $limit: parseInt(limit) },
            {
                $lookup: {
                    from: 'cases', // The collection name for 'Case' model
                    localField: 'JOB_OPP_PWD_NUMBER',
                    foreignField: 'CASE_NUMBER',
                    as: 'pwdDoc'
                }
            },
            {
                $addFields: {
                    pwdDoc: { $arrayElemAt: ['$pwdDoc', 0] }
                }
            },
            {
                $addFields: {
                    PWD_DETERMINATION_DATE: '$pwdDoc.DETERMINATION_DATE',
                    PWD_RECEIVED_DATE: '$pwdDoc.RECEIVED_DATE',
                    PWD_EXPIRATION_DATE: '$pwdDoc.PWD_WAGE_EXPIRATION_DATE'
                }
            },
            {
                $project: {
                    pwdDoc: 0 // Remove the nested doc to keep it flat
                }
            }
        ]);

        const cases = results;

        const totalCount = Object.keys(query).length === 0
            ? await PermCase.estimatedDocumentCount()
            : await PermCase.countDocuments(query);

        res.json({
            cases,
            totalPages: Math.ceil(totalCount / limit),
            currentPage: parseInt(page),
            totalCount
        });
    } catch (error) {
        console.error('PERM Search API error:', error);
        res.status(500).json({ error: 'An error occurred while searching PERM cases' });
    }
});

// Get available years for PERM dropdowns
router.get('/perm/years', async (req, res) => {
    try {
        const result = await PermCase.aggregate([
            {
                $group: {
                    _id: null,
                    minDec: { $min: "$DECISION_DATE" },
                    maxDec: { $max: "$DECISION_DATE" },
                    minRec: { $min: "$RECEIVED_DATE" },
                    maxRec: { $max: "$RECEIVED_DATE" }
                }
            }
        ]);

        if (!result || result.length === 0) {
            return res.json([]);
        }

        const stats = result[0];
        const years = new Set();

        const addYear = (dateField) => {
            if (dateField && dateField instanceof Date) {
                const y = dateField.getFullYear();
                if (y > 1900 && y < 2100) years.add(y);
            }
        };

        addYear(stats.minDec);
        addYear(stats.maxDec);
        addYear(stats.minRec);
        addYear(stats.maxRec);

        if (years.size === 0) {
            return res.json([]);
        }

        const minYear = Math.min(...Array.from(years));
        const maxYear = Math.max(...Array.from(years));

        const yearRange = [];
        for (let y = maxYear; y >= minYear; y--) {
            yearRange.push(y);
        }

        res.json(yearRange);
    } catch (error) {
        console.error('Get PERM years API error:', error);
        res.status(500).json({ error: 'An error occurred while fetching PERM years' });
    }
});
