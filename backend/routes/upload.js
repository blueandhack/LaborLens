const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const exceljs = require('exceljs');
const unzipper = require('unzipper');
const Case = require('../models/Case');
const PermCase = require('../models/PermCase');
const { authMiddleware } = require('./admin');
let invalidateSearchCache = () => {};
// Lazy import to avoid circular dependency
setImmediate(() => { ({ invalidateCache: invalidateSearchCache } = require('./search')); });

// Setup multer for uploading files to a temp directory
const upload = multer({ dest: '/tmp/pwd_uploads/' });

// Helper to convert excel serial date to JS Date
function excelDateToJSDate(serial) {
    if (!serial || serial <= 0) return null;
    if (typeof serial === 'string' && serial.trim() === '') return null;
    if (typeof serial === 'number') {
        const jsDate = new Date(Math.round((serial - 25569) * 86400 * 1000));
        // If the date is still effectively pre-1970 or invalid (e.g. 1969), discard it
        if (jsDate.getFullYear() <= 1970) return null;
        return jsDate;
    }
    // Fallback if already string/date format
    const parsed = new Date(serial);
    if (isNaN(parsed.getTime()) || parsed.getFullYear() <= 1970) return null;
    return parsed;
}

async function getTotalRows(filePath) {
    return new Promise((resolve) => {
        let maxRow = null;
        let resolved = false;

        const cleanup = () => {
            if (!resolved) {
                resolved = true;
                resolve(maxRow || 995000); // Default fallback roughly equal to the dataset size
            }
        };

        fs.createReadStream(filePath)
            .pipe(unzipper.Parse())
            .on('entry', function (entry) {
                if (entry.path === "xl/worksheets/sheet1.xml") {
                    let xmlBuffer = '';
                    entry.on('data', (chunk) => {
                        if (resolved) return;
                        xmlBuffer += chunk.toString();
                        const match = xmlBuffer.match(/<dimension ref="[A-Z]+[0-9]+:[A-Z]+([0-9]+)"/);
                        if (match) {
                            maxRow = parseInt(match[1], 10);
                            entry.autodrain();
                            cleanup();
                        } else if (xmlBuffer.length > 512 * 1024) { // Only read first 512KB for dimension tag
                            entry.autodrain();
                            cleanup();
                        }
                    });
                    entry.on('end', () => {
                        cleanup();
                    });
                } else {
                    entry.autodrain();
                }
            })
            .on('close', () => cleanup())
            .on('error', (err) => {
                console.error("Unzip error:", err);
                cleanup();
            });
    });
}

let currentJob = {
    status: 'idle', // 'idle', 'analyzing', 'starting', 'progress', 'done', 'error'
    processed: 0,
    total: 0,
    inserted: 0,
    updated: 0,
    logs: [],
    message: ''
};

// Polling endpoint for frontend
router.get('/status', authMiddleware, (req, res) => {
    res.json(currentJob);
});

router.post('/', authMiddleware, upload.single('file'), async (req, res) => {
    if (!req.file) {
        return res.status(400).json({ error: 'No file uploaded' });
    }

    if (currentJob.status !== 'idle' && currentJob.status !== 'done' && currentJob.status !== 'error') {
        return res.status(429).json({ error: 'A background import is already running or analyzing.' });
    }

    const filePath = req.file.path;
    const importType = req.body.type || 'pwd'; // 'pwd' or 'perm'

    // Acknowledge upload immediately
    res.status(202).json({ message: 'File accepted. Beginning background processing.' });

    // Reset Job State
    currentJob = {
        status: 'analyzing',
        processed: 0,
        total: 0,
        inserted: 0,
        updated: 0,
        logs: ['File uploaded. Analyzing file size...'],
        message: 'Analyzing file size...'
    };

    // Run async background processing
    (async () => {
        try {
            let totalRows = await getTotalRows(filePath);
            if (totalRows > 1) totalRows -= 1;

            currentJob.status = 'starting';
            currentJob.total = totalRows;
            currentJob.message = 'Starting import stream...';
            currentJob.logs.push(`Detected approx ${totalRows} rows. Starting stream...`);

            const options = {
                sharedStrings: 'cache',
                hyperlinks: 'ignore',
                worksheets: 'emit'
            };

            const workbookReader = new exceljs.stream.xlsx.WorkbookReader(filePath, options);

            let batch = [];
            const batchSize = 5000;
            const activePromises = new Set();
            const maxConcurrent = 4;

            const Model = importType === 'perm' ? PermCase : Case;

            for await (const worksheetReader of workbookReader) {
                let isFirstRow = true;
                let headers = [];

                for await (const row of worksheetReader) {
                    if (isFirstRow || row.number === 1) {
                        headers = row.values.slice(1);
                        isFirstRow = false;
                        continue;
                    }

                    const rowData = row.values.slice(1);
                    const caseObj = {};
                    headers.forEach((h, index) => {
                        if (h && typeof h === 'string') {
                            caseObj[h] = rowData[index];
                        }
                    });

                    if (!caseObj['CASE_NUMBER']) {
                        continue;
                    }

                    if (importType === 'pwd') {
                        if (caseObj['VISA_CLASS'] && caseObj['VISA_CLASS'].toUpperCase() === 'PERM') {
                            // The dataset might be a mixed dataset. For PWD, standard is H-1B, H-1B1, E-3, etc. 
                            // But usually we just accept everything if we are in the PWD upload context.
                            // The previous bug was rejecting EVERYTHING unless VISA_CLASS === 'PERM'.  
                        }
                    }

                    const dateFields = importType === 'pwd' ? [
                        'RECEIVED_DATE',
                        'DETERMINATION_DATE',
                        'PREVAIL_WAGE_DETERM_DATE',
                        'PWD_WAGE_EXPIRATION_DATE',
                        'REDETERMINATION_DATE',
                        'CENTER_DIRECTOR_REVIEW_DATE',
                        'WITHDRAWAL_DATE',
                        'SURVEY_PUBLICATION_DATE'
                    ] : [
                        'RECEIVED_DATE',
                        'DECISION_DATE',
                        'RECR_INFO_JOB_START_DATE',
                        'RECR_INFO_JOB_END_DATE',
                        'RECR_INFO_AD_DATE1',
                        'RECR_INFO_AD_DATE2'
                    ];

                    dateFields.forEach(dateField => {
                        if (caseObj[dateField]) {
                            caseObj[dateField] = excelDateToJSDate(caseObj[dateField]);
                        }
                    });

                    // Populate normalized lowercase fields for fast indexed search
                    if (importType === 'pwd') {
                        if (caseObj['EMPLOYER_LEGAL_BUSINESS_NAME'])
                            caseObj['EMPLOYER_NAME_LOWER'] = caseObj['EMPLOYER_LEGAL_BUSINESS_NAME'].toLowerCase();
                        if (caseObj['JOB_TITLE'])
                            caseObj['JOB_TITLE_LOWER'] = caseObj['JOB_TITLE'].toLowerCase();
                        if (caseObj['EMPLOYER_CITY'])
                            caseObj['EMPLOYER_CITY_LOWER'] = caseObj['EMPLOYER_CITY'].toLowerCase();
                    } else {
                        if (caseObj['EMP_BUSINESS_NAME'])
                            caseObj['EMP_BUSINESS_NAME_LOWER'] = caseObj['EMP_BUSINESS_NAME'].toLowerCase();
                        if (caseObj['JOB_TITLE'])
                            caseObj['JOB_TITLE_LOWER'] = caseObj['JOB_TITLE'].toLowerCase();
                        if (caseObj['EMP_CITY'])
                            caseObj['EMP_CITY_LOWER'] = caseObj['EMP_CITY'].toLowerCase();
                    }

                    currentJob.processed++;
                    currentJob.status = 'progress';

                    batch.push({
                        updateOne: {
                            filter: { CASE_NUMBER: caseObj['CASE_NUMBER'] },
                            update: { $set: caseObj },
                            upsert: true
                        }
                    });

                    if (batch.length >= batchSize) {
                        const currentBatch = [...batch];
                        batch = [];

                        const promise = Model.bulkWrite(currentBatch, { ordered: false })
                            .then(bulkResult => {
                                currentJob.inserted += bulkResult.upsertedCount || 0;
                                currentJob.updated += bulkResult.modifiedCount || 0;
                            })
                            .catch(err => {
                                console.error('Bulk write error:', err);
                            })
                            .finally(() => {
                                activePromises.delete(promise);
                            });

                        activePromises.add(promise);

                        if (activePromises.size >= maxConcurrent) {
                            await Promise.race(activePromises);
                        }
                    }
                }
                break; // First sheet only
            }

            if (batch.length > 0) {
                const promise = Model.bulkWrite(batch, { ordered: false })
                    .then(bulkResult => {
                        currentJob.inserted += bulkResult.upsertedCount || 0;
                        currentJob.updated += bulkResult.modifiedCount || 0;
                    })
                    .catch(err => {
                        console.error('Bulk write error:', err);
                    })
                    .finally(() => {
                        activePromises.delete(promise);
                    });
                activePromises.add(promise);
            }

            await Promise.all(activePromises);

            fs.unlink(filePath, (err) => {
                if (err) console.error("Temp file deletion error:", err);
            });

            currentJob.status = 'done';
            currentJob.message = 'Import complete!';
            currentJob.logs.push(`Finished! Inserted: ${currentJob.inserted}, Updated: ${currentJob.updated}, Total Processed: ${currentJob.processed}`);
            invalidateSearchCache();

        } catch (err) {
            console.error('Background import failed:', err);
            fs.unlink(filePath, () => { });
            currentJob.status = 'error';
            currentJob.message = err.message;
            currentJob.logs.push(`Error: ${err.message}`);
        }
    })();
});

module.exports = router;
