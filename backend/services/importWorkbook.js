const { readWorkbookRows } = require('./xlsxRows');

const DATE_FIELDS = {
    pwd: ['RECEIVED_DATE', 'DETERMINATION_DATE', 'PREVAIL_WAGE_DETERM_DATE',
        'PWD_WAGE_EXPIRATION_DATE', 'REDETERMINATION_DATE', 'CENTER_DIRECTOR_REVIEW_DATE',
        'WITHDRAWAL_DATE', 'SURVEY_PUBLICATION_DATE'],
    perm: ['RECEIVED_DATE', 'DECISION_DATE', 'RECR_INFO_JOB_START_DATE',
        'RECR_INFO_JOB_END_DATE', 'RECR_INFO_AD_DATE1', 'RECR_INFO_AD_DATE2'],
};

function cellValue(value) {
    if (value && typeof value === 'object' && !(value instanceof Date)) {
        if ('result' in value) return cellValue(value.result);
        if (value.richText) return value.richText.map(part => part.text).join('');
        if ('text' in value) return value.text;
        return null;
    }
    return value;
}

function excelDateToJSDate(value) {
    if (value === null || value === undefined || value === '') return null;
    const date = typeof value === 'number'
        ? new Date(Math.round((value - 25569) * 86400000)) : new Date(value);
    return Number.isFinite(date.getTime()) && date.getUTCFullYear() > 1970 ? date : null;
}

function normalizeRecord(record, type) {
    record.CASE_NUMBER = String(record.CASE_NUMBER).trim();
    for (const field of DATE_FIELDS[type]) {
        if (record[field] !== undefined) record[field] = excelDateToJSDate(record[field]);
    }
    const fields = type === 'pwd'
        ? { EMPLOYER_LEGAL_BUSINESS_NAME: 'EMPLOYER_NAME_LOWER', JOB_TITLE: 'JOB_TITLE_LOWER', EMPLOYER_CITY: 'EMPLOYER_CITY_LOWER' }
        : { EMP_BUSINESS_NAME: 'EMP_BUSINESS_NAME_LOWER', JOB_TITLE: 'JOB_TITLE_LOWER', EMP_CITY: 'EMP_CITY_LOWER' };
    for (const [source, target] of Object.entries(fields)) {
        record[target] = record[source] == null ? '' : String(record[source]).toLowerCase();
    }
    return record;
}

// The same streaming, case-number upsert path serves uploads and scheduled jobs.
// Write failures propagate: a partially imported workbook must be retried.
async function importWorkbook(filePath, { type, Model, batchSize = 1000, onProgress = async () => {}, ensureActive = () => {} }) {
    if (!DATE_FIELDS[type]) throw new Error('Import type must be pwd or perm');
    const stats = { processed: 0, inserted: 0, updated: 0 };
    let foundSheet;
    let currentSheet;
    let headers;
    let batch = [];
    async function flush() {
        if (!batch.length) return;
        ensureActive();
        const result = await Model.bulkWrite(batch, { ordered: false, throwOnValidationError: true });
        stats.inserted += result.upsertedCount || 0;
        stats.updated += result.modifiedCount || 0;
        batch = [];
        await onProgress({ ...stats });
    }
    for await (const row of readWorkbookRows(filePath)) {
        if (currentSheet !== row.sheet) {
            currentSheet = row.sheet;
            headers = undefined;
        }
        if (foundSheet && row.sheet !== foundSheet) continue;
        ensureActive();
        const values = row.values.slice(1).map(cellValue);
        if (!headers) {
            const candidate = values.map(value => typeof value === 'string' ? value.trim().toUpperCase() : '');
            const employer = type === 'pwd' ? 'EMPLOYER_LEGAL_BUSINESS_NAME' : 'EMP_BUSINESS_NAME';
            if (candidate.includes('CASE_NUMBER') && candidate.includes(employer)) {
                headers = candidate;
                foundSheet = row.sheet;
            }
            continue;
        }
        const record = {};
        headers.forEach((header, index) => {
            // Keep missing cells explicit so a correction can clear an old value.
            if (header && /^[A-Z][A-Z0-9_]*$/.test(header)) record[header] = values[index] ?? null;
        });
        if (!record.CASE_NUMBER || !String(record.CASE_NUMBER).trim()) continue;
        normalizeRecord(record, type);
        batch.push({ updateOne: {
            filter: { CASE_NUMBER: record.CASE_NUMBER }, update: { $set: record }, upsert: true,
        } });
        stats.processed++;
        if (batch.length >= batchSize) await flush();
    }
    await flush();
    if (!foundSheet || !stats.processed) throw new Error(`No ${type.toUpperCase()} case rows found; check the workbook headers`);
    return stats;
}

module.exports = { importWorkbook, normalizeRecord, excelDateToJSDate };
