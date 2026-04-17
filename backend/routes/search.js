const express = require('express');
const router = express.Router();
const Case = require('../models/Case');
const PermCase = require('../models/PermCase');

// Escape special regex characters to prevent injection and ensure index use
const escapeRegex = (str) => str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Simple in-memory cache for the years dropdown (invalidated on import)
const cache = {};
const CACHE_TTL = 10 * 60 * 1000; // 10 minutes
const getCached = (key) => {
    const entry = cache[key];
    if (entry && Date.now() - entry.ts < CACHE_TTL) return entry.value;
    return null;
};
const setCached = (key, value) => { cache[key] = { value, ts: Date.now() }; };
const invalidateCache = () => { Object.keys(cache).forEach(k => delete cache[k]); };

// Fields returned for the card list view (avoids fetching 100+ unused fields)
const PWD_CARD_FIELDS = {
    CASE_NUMBER: 1, CASE_STATUS: 1,
    EMPLOYER_LEGAL_BUSINESS_NAME: 1, EMPLOYER_CITY: 1, EMPLOYER_STATE: 1,
    JOB_TITLE: 1, VISA_CLASS: 1, NAICS_CODE: 1,
    PWD_WAGE_RATE: 1, PWD_UNIT_OF_PAY: 1, PWD_OES_WAGE_LEVEL: 1,
    PWD_SOC_CODE: 1, PWD_SOC_TITLE: 1,
    DETERMINATION_DATE: 1, RECEIVED_DATE: 1, PWD_WAGE_EXPIRATION_DATE: 1,
};

const PERM_CARD_FIELDS = {
    CASE_NUMBER: 1, CASE_STATUS: 1,
    EMP_BUSINESS_NAME: 1, EMP_CITY: 1, EMP_STATE: 1,
    JOB_TITLE: 1, VISA_CLASS: 1, EMP_NAICS_CODE: 1,
    PWD_WAGE_RATE: 1, PWD_UNIT_OF_PAY: 1, PWD_OES_WAGE_LEVEL: 1,
    PWD_SOC_CODE: 1, PWD_SOC_TITLE: 1,
    JOB_OPP_PWD_NUMBER: 1,
    DECISION_DATE: 1, RECEIVED_DATE: 1,
};

// ── PWD Search ────────────────────────────────────────────────────────────────

router.get('/', async (req, res) => {
    try {
        const {
            company, location, caseNumber, jobTitle,
            determinationYear, receivedYear,
            page = 1, limit = 20
        } = req.query;

        const lim  = parseInt(limit);
        const skip = (parseInt(page) - 1) * lim;
        const sort = { DETERMINATION_DATE: -1, EMPLOYER_LEGAL_BUSINESS_NAME: 1 };
        const conditions = [];

        // Use pre-computed lowercase fields with case-sensitive prefix regex so
        // MongoDB can do a B-tree range scan instead of a full collection scan.
        if (company?.trim())
            conditions.push({ EMPLOYER_NAME_LOWER: { $regex: `^${escapeRegex(company.trim().toLowerCase())}` } });

        if (location?.trim()) {
            const loc = `^${escapeRegex(location.trim().toLowerCase())}`;
            conditions.push({ $or: [
                { EMPLOYER_CITY_LOWER: { $regex: loc } },
                { EMPLOYER_STATE:      { $regex: loc, $options: 'i' } }
            ]});
        }

        if (caseNumber?.trim())
            conditions.push({ CASE_NUMBER: { $regex: `^${escapeRegex(caseNumber.trim())}`, $options: 'i' } });

        if (jobTitle?.trim())
            conditions.push({ JOB_TITLE_LOWER: { $regex: `^${escapeRegex(jobTitle.trim().toLowerCase())}` } });

        if (determinationYear && !isNaN(parseInt(determinationYear))) {
            const y = parseInt(determinationYear);
            conditions.push({ DETERMINATION_DATE: {
                $gte: new Date(`${y}-01-01T00:00:00.000Z`),
                $lte: new Date(`${y}-12-31T23:59:59.999Z`)
            }});
        }

        if (receivedYear && !isNaN(parseInt(receivedYear))) {
            const y = parseInt(receivedYear);
            conditions.push({ RECEIVED_DATE: {
                $gte: new Date(`${y}-01-01T00:00:00.000Z`),
                $lte: new Date(`${y}-12-31T23:59:59.999Z`)
            }});
        }

        const query      = conditions.length > 0 ? { $and: conditions } : {};
        const hasFilters = conditions.length > 0;

        // Hint the most selective index for each filter combination.
        let hint;
        if (company?.trim())         hint = { EMPLOYER_NAME_LOWER: 1, DETERMINATION_DATE: -1 };
        else if (jobTitle?.trim())   hint = { JOB_TITLE_LOWER: 1, DETERMINATION_DATE: -1 };
        else if (caseNumber?.trim()) hint = { CASE_NUMBER: 1 };

        // Run find and count in parallel — halves round-trip time
        const findQuery = Case.find(query, PWD_CARD_FIELDS)
            .sort(sort).skip(skip).limit(lim).lean();
        if (hint) findQuery.hint(hint);

        const [cases, totalCount] = await Promise.all([
            findQuery,
            hasFilters
                ? Case.countDocuments(query)
                : Case.estimatedDocumentCount()
        ]);

        res.json({
            cases,
            totalPages: Math.ceil(totalCount / lim),
            currentPage: parseInt(page),
            totalCount
        });
    } catch (error) {
        console.error('Search API error:', error);
        res.status(500).json({ error: 'An error occurred while searching' });
    }
});

// ── PWD Years dropdown (cached) ───────────────────────────────────────────────

router.get('/years', async (req, res) => {
    try {
        const cached = getCached('pwd_years');
        if (cached) return res.json(cached);

        const result = await Case.aggregate([
            { $group: {
                _id: null,
                minDet: { $min: '$DETERMINATION_DATE' },
                maxDet: { $max: '$DETERMINATION_DATE' },
                minRec: { $min: '$RECEIVED_DATE' },
                maxRec: { $max: '$RECEIVED_DATE' }
            }}
        ]);

        if (!result?.length) return res.json([]);

        const { minDet, maxDet, minRec, maxRec } = result[0];
        const years = new Set();
        [minDet, maxDet, minRec, maxRec].forEach(d => {
            if (d instanceof Date) {
                const y = d.getFullYear();
                if (y > 1900 && y < 2100) years.add(y);
            }
        });

        if (!years.size) return res.json([]);

        const min = Math.min(...years);
        const max = Math.max(...years);
        const range = Array.from({ length: max - min + 1 }, (_, i) => max - i);

        setCached('pwd_years', range);
        res.json(range);
    } catch (error) {
        console.error('Get years API error:', error);
        res.status(500).json({ error: 'An error occurred while fetching years' });
    }
});

// ── PERM Search ───────────────────────────────────────────────────────────────

router.get('/perm', async (req, res) => {
    try {
        const {
            company, location, caseNumber, jobTitle,
            decisionYear, receivedYear,
            page = 1, limit = 20
        } = req.query;

        const lim  = parseInt(limit);
        const skip = (parseInt(page) - 1) * lim;
        const sort = { DECISION_DATE: -1, EMP_BUSINESS_NAME: 1 };
        const conditions = [];

        if (company?.trim())
            conditions.push({ EMP_BUSINESS_NAME_LOWER: { $regex: `^${escapeRegex(company.trim().toLowerCase())}` } });

        if (location?.trim()) {
            const loc = `^${escapeRegex(location.trim().toLowerCase())}`;
            conditions.push({ $or: [
                { EMP_CITY_LOWER: { $regex: loc } },
                { EMP_STATE:      { $regex: loc, $options: 'i' } }
            ]});
        }

        if (caseNumber?.trim())
            conditions.push({ CASE_NUMBER: { $regex: `^${escapeRegex(caseNumber.trim())}`, $options: 'i' } });

        if (jobTitle?.trim())
            conditions.push({ JOB_TITLE_LOWER: { $regex: `^${escapeRegex(jobTitle.trim().toLowerCase())}` } });

        if (decisionYear && !isNaN(parseInt(decisionYear))) {
            const y = parseInt(decisionYear);
            conditions.push({ DECISION_DATE: {
                $gte: new Date(`${y}-01-01T00:00:00.000Z`),
                $lte: new Date(`${y}-12-31T23:59:59.999Z`)
            }});
        }

        if (receivedYear && !isNaN(parseInt(receivedYear))) {
            const y = parseInt(receivedYear);
            conditions.push({ RECEIVED_DATE: {
                $gte: new Date(`${y}-01-01T00:00:00.000Z`),
                $lte: new Date(`${y}-12-31T23:59:59.999Z`)
            }});
        }

        const query      = conditions.length > 0 ? { $and: conditions } : {};
        const hasFilters = conditions.length > 0;

        // Hint the most selective index for each filter combination.
        let permHint;
        if (company?.trim())         permHint = { EMP_BUSINESS_NAME_LOWER: 1, DECISION_DATE: -1 };
        else if (jobTitle?.trim())   permHint = { JOB_TITLE_LOWER: 1, DECISION_DATE: -1 };
        else if (caseNumber?.trim()) permHint = { CASE_NUMBER: 1 };

        const permPipeline = [
            { $match: query },
            { $sort: sort },
            { $skip: skip },
            { $limit: lim },
            { $project: PERM_CARD_FIELDS },
            { $lookup: {
                from: 'cases',
                localField: 'JOB_OPP_PWD_NUMBER',
                foreignField: 'CASE_NUMBER',
                as: 'pwdDoc',
                pipeline: [{ $project: {
                    DETERMINATION_DATE: 1,
                    RECEIVED_DATE: 1,
                    PWD_WAGE_EXPIRATION_DATE: 1
                }}]
            }},
            { $addFields: { pwdDoc: { $arrayElemAt: ['$pwdDoc', 0] } } },
            { $addFields: {
                PWD_DETERMINATION_DATE: '$pwdDoc.DETERMINATION_DATE',
                PWD_RECEIVED_DATE:      '$pwdDoc.RECEIVED_DATE',
                PWD_EXPIRATION_DATE:    '$pwdDoc.PWD_WAGE_EXPIRATION_DATE'
            }},
            { $project: { pwdDoc: 0 } }
        ];

        const permAggQuery = PermCase.aggregate(permPipeline);
        if (permHint) permAggQuery.option({ hint: permHint });

        // Run aggregation and count in parallel
        const [results, totalCount] = await Promise.all([
            permAggQuery,
            hasFilters
                ? PermCase.countDocuments(query)
                : PermCase.estimatedDocumentCount()
        ]);

        res.json({
            cases: results,
            totalPages: Math.ceil(totalCount / lim),
            currentPage: parseInt(page),
            totalCount
        });
    } catch (error) {
        console.error('PERM Search API error:', error);
        res.status(500).json({ error: 'An error occurred while searching PERM cases' });
    }
});

// ── PERM Years dropdown (cached) ──────────────────────────────────────────────

router.get('/perm/years', async (req, res) => {
    try {
        const cached = getCached('perm_years');
        if (cached) return res.json(cached);

        const result = await PermCase.aggregate([
            { $group: {
                _id: null,
                minDec: { $min: '$DECISION_DATE' },
                maxDec: { $max: '$DECISION_DATE' },
                minRec: { $min: '$RECEIVED_DATE' },
                maxRec: { $max: '$RECEIVED_DATE' }
            }}
        ]);

        if (!result?.length) return res.json([]);

        const { minDec, maxDec, minRec, maxRec } = result[0];
        const years = new Set();
        [minDec, maxDec, minRec, maxRec].forEach(d => {
            if (d instanceof Date) {
                const y = d.getFullYear();
                if (y > 1900 && y < 2100) years.add(y);
            }
        });

        if (!years.size) return res.json([]);

        const min = Math.min(...years);
        const max = Math.max(...years);
        const range = Array.from({ length: max - min + 1 }, (_, i) => max - i);

        setCached('perm_years', range);
        res.json(range);
    } catch (error) {
        console.error('Get PERM years API error:', error);
        res.status(500).json({ error: 'An error occurred while fetching PERM years' });
    }
});

module.exports = { router, invalidateCache };
