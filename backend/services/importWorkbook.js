const { createHash } = require('crypto');
const { resolveSourceCells } = require('./sourceCellResolutions');
const { readWorkbookRows } = require('./xlsxRows');
const { ALIASES, DATE_FIELDS, NUMBER_FIELDS, buildLayout, normalizeHeader, normalizeRecord, excelDateToJSDate, isMissing, eventTime } = require('./dolLayout');

const VALIDATION_VERSION = 2;
const rowKey = row => `${row.sheet}:${row.number}`;
const sourceRank = source => source.fiscalYear * 100 + source.quarter * 10
    + (/new_form|revised_form/i.test(source.filename || '') ? 2 : /old_form/i.test(source.filename || '') ? 1 : 0);

async function* records(filePath, { type, ensureActive = () => {} }) {
    let sheet;
    let layout;
    for await (const row of readWorkbookRows(filePath)) {
        ensureActive();
        if (sheet !== row.sheet) { sheet = row.sheet; layout = null; }
        const values = row.values.slice(1);
        if (!layout) {
            layout = buildLayout(values, type);
            if (layout) yield { layout, sheet };
            else if (values.length >= 3 && values.map(normalizeHeader).some(field => ['CASE_NUMBER', 'CASE_NO', 'LCA_CASE_NUMBER'].includes(field))) {
                throw new Error(`No ${type.toUpperCase()} case rows: unsupported program/employer headers in ${sheet}`);
            }
            continue;
        }
        if (values.every(isMissing)) { yield { blank: true }; continue; }
        // Some releases repeat the column headings between sections.
        const idColumn = layout.headers.indexOf(layout.mapped.CASE_NUMBER);
        if (['CASE_NUMBER', 'CASE_NO', 'LCA_CASE_NUMBER'].includes(String(values[idColumn] ?? '').trim().toUpperCase())) { yield { repeatedHeader: true }; continue; }
        const record = {};
        layout.headers.forEach((header, index) => { if (header) record[header] = values[index] ?? null; });
        const issues = [];
        normalizeRecord(record, type, { layout, date1904: row.date1904, issues });
        if (type === 'h1b' && record.VISA_CLASS && !/^H-?1B$/i.test(record.VISA_CLASS)) {
            yield { excluded: true, visaClass: record.VISA_CLASS };
            continue;
        }
        // Unknown visa classes must not silently disappear from an H-1B import.
        if (type === 'h1b' && !record.VISA_CLASS) throw new Error('H-1B workbook contains a row without VISA_CLASS; no cases imported');
        if (row.errors.length) {
            record._DOL_CELL_ERRORS = Object.fromEntries(row.errors.map(error => [layout.headers[error.column - 1] || String(error.column), error.value]));
            for (const error of row.errors) issues.push({ field: layout.headers[error.column - 1], reason: 'excel_error', value: error.value });
        }
        const resolutions = resolveSourceCells(record, type);
        for (const issue of issues) {
            if (issue.reason === 'excel_error' && resolutions[issue.field]) issue.resolution = resolutions[issue.field];
        }
        yield { record, key: rowKey(row), issues };
    }
}

// Scan every row before the first database write. Keep only row fingerprints
// and duplicate-selection metadata in memory, not entire large workbooks.
async function auditWorkbook(filePath, { type, ensureActive = () => {}, onProgress = async () => {} }) {
    const report = { version: VALIDATION_VERSION, type, layouts: [], rows: 0, validRows: 0,
        blankRows: 0, repeatedHeaders: 0, rejectedRows: 0, duplicateRows: 0, identicalDuplicates: 0,
        variantCases: 0, sameEventVariantCases: 0, uniqueCases: 0, missingValues: {}, issues: {}, resolvedIssues: {}, examples: [] };
    const entries = new Map();
    try {
        for await (const item of records(filePath, { type, ensureActive })) {
            if (item.layout) { report.layouts.push({ sheet: item.sheet, ...item.layout }); continue; }
            if (item.blank) { report.blankRows++; continue; }
            if (item.repeatedHeader) { report.repeatedHeaders++; continue; }
            if (item.excluded) {
                report.rows++;
                report.excludedRows = (report.excludedRows || 0) + 1;
                report.excludedVisaClasses ||= Object.create(null);
                report.excludedVisaClasses[item.visaClass] = (report.excludedVisaClasses[item.visaClass] || 0) + 1;
                continue;
            }
            const { record, key, issues } = item;
            report.rows++;
            if (!record.CASE_NUMBER) {
                report.rejectedRows++;
                if (report.examples.length < 10) report.examples.push({ row: key, reason: 'missing_case_number' });
                continue;
            }
            report.validRows++;
            for (const field of Object.keys(ALIASES[type])) {
                if (isMissing(record[field])) report.missingValues[field] = (report.missingValues[field] || 0) + 1;
            }
            for (const issue of issues) {
                const code = `${issue.field}:${issue.reason}`;
                report.issues[code] = (report.issues[code] || 0) + 1;
                if (issue.resolution) report.resolvedIssues[code] = (report.resolvedIssues[code] || 0) + 1;
                if (report.examples.length < 10) report.examples.push({ row: key, ...issue });
            }
            const hash = createHash('sha256').update(JSON.stringify(record)).digest('hex');
            const time = eventTime(record, type);
            const priority = ['REDETERMINATION_DATE', 'WITHDRAWAL_DATE', 'CENTER_DIRECTOR_REVIEW_DATE'].filter(field => record[field] instanceof Date).length;
            const previous = entries.get(record.CASE_NUMBER);
            if (!previous) entries.set(record.CASE_NUMBER, { key, hash, time, priority });
            else {
                report.duplicateRows++;
                if (previous.hash === hash || previous.alternates?.some(other => other.hash === hash)) report.identicalDuplicates++;
                else {
                    previous.alternates ||= [];
                    if (!previous.alternates.length) report.variantCases++;
                    if (time === previous.time && !previous.sameEvent) { report.sameEventVariantCases++; previous.sameEvent = true; }
                    if (time > previous.time || (time === previous.time && priority > previous.priority)) {
                        previous.alternates.push({ key: previous.key, hash: previous.hash });
                        Object.assign(previous, { key, hash, time, priority });
                    } else previous.alternates.push({ key, hash });
                }
            }
            if (report.rows % 10000 === 0) await onProgress({ rows: report.rows });
        }
    } catch (error) {
        if (error.code === 'SOURCE_REVIEW_REQUIRED') error.report = { ...report, canImport: false,
            blockingReason: error.message, missingRequiredFields: error.fields, unsupportedHeaders: error.headers };
        throw error;
    }
    report.uniqueCases = entries.size;
    report.canImport = report.uniqueCases > 0 && report.rejectedRows === 0;
    if (!report.layouts.length || !report.validRows) throw Object.assign(new Error(`No ${type.toUpperCase()} case rows found; check workbook headers`), { report });
    return { report, entries };
}

async function importWorkbook(filePath, {
    type, Model, source, historical = false, validation, batchSize = 1000,
    onProgress = async () => {}, onValidated = async () => {}, ensureActive = () => {},
}) {
    const audit = validation || await auditWorkbook(filePath, { type, ensureActive });
    await onValidated(audit.report);
    if (!audit.report.canImport) throw Object.assign(new Error(`Workbook contains ${audit.report.rejectedRows} records without a case number; no cases imported`), { report: audit.report });
    const stats = { processed: 0, inserted: 0, updated: 0 };
    if (historical) Object.assign(stats, { protected: 0, supplemented: 0 });
    let batch = [];
    const duplicates = new Map();
    const canonical = [...new Set([...Object.keys(ALIASES[type]), ...DATE_FIELDS, ...NUMBER_FIELDS])];
    const lowerFields = type === 'h1b'
        ? { EMPLOYER_NAME: 'EMPLOYER_NAME_LOWER', JOB_TITLE: 'JOB_TITLE_LOWER', EMPLOYER_CITY: 'EMPLOYER_CITY_LOWER' }
        : type === 'pwd'
        ? { EMPLOYER_LEGAL_BUSINESS_NAME: 'EMPLOYER_NAME_LOWER', JOB_TITLE: 'JOB_TITLE_LOWER', EMPLOYER_CITY: 'EMPLOYER_CITY_LOWER' }
        : { EMP_BUSINESS_NAME: 'EMP_BUSINESS_NAME_LOWER', JOB_TITLE: 'JOB_TITLE_LOWER', EMP_CITY: 'EMP_CITY_LOWER' };
    // H-1B's declared fields are all typed by normalizeRecord and the complete
    // preflight verifies case identifiers before writes. Avoid re-casting every
    // wide disclosure through Mongoose; preserve its timestamp/upsert behavior.
    const nativeWrites = type === 'h1b' && typeof Model.collection?.bulkWrite === 'function';
    async function flush() {
        if (!batch.length) return;
        ensureActive();
        let existing = new Map();
        if (historical) {
            const projection = Object.fromEntries([...canonical, ...Object.values(ALIASES[type]).flat(), ...Object.values(lowerFields), 'CASE_NUMBER', '_DOL_SOURCE'].map(field => [field, 1]));
            const found = await Model.find({ CASE_NUMBER: { $in: batch.map(record => record.CASE_NUMBER) } }, projection).lean();
            existing = new Map(found.map(record => [record.CASE_NUMBER, record]));
        }
        const operations = [];
        for (const record of batch) {
            const old = existing.get(record.CASE_NUMBER);
            let update = record;
            if (historical && old) {
                if (old._DOL_SOURCE && old._DOL_SOURCE.rank > sourceRank(source)) { stats.protected++; continue; }
                if (!old._DOL_SOURCE) {
                    // Untracked existing records may be newer. Fill only absent
                    // canonical fields, preserving every existing nonempty value.
                    update = {};
                    const own = { ...old };
                    for (const [field, aliases] of Object.entries(ALIASES[type])) {
                        if (isMissing(own[field])) {
                            const alias = aliases.find(alias => !isMissing(old[alias]));
                            if (alias) own[field] = old[alias];
                        }
                    }
                    normalizeRecord(own, type);
                    for (const field of canonical) {
                        const value = !isMissing(own[field]) ? own[field] : record[field];
                        if (isMissing(old[field]) && !isMissing(value)) update[field] = value;
                    }
                    for (const [field, lower] of Object.entries(lowerFields)) {
                        const value = update[field] ?? old[field];
                        if (isMissing(old[lower]) && !isMissing(value)) update[lower] = String(value).toLowerCase();
                    }
                    if (!Object.keys(update).length) { stats.protected++; continue; }
                    update._DOL_SUPPLEMENT_SOURCE = { url: source.url, fiscalYear: source.fiscalYear, fields: Object.keys(update) };
                    stats.supplemented++;
                }
            }
            if (source && update === record) record._DOL_SOURCE = { ...source, rank: sourceRank(source), validationVersion: VALIDATION_VERSION };
            const timestamps = nativeWrites ? { $setOnInsert: { createdAt: new Date(), __v: 0 } } : {};
            operations.push({ updateOne: { filter: { CASE_NUMBER: record.CASE_NUMBER },
                update: { $set: nativeWrites ? { ...update, updatedAt: new Date() } : update, ...timestamps }, upsert: true } });
        }
        if (operations.length) {
            const writer = nativeWrites ? Model.collection : Model;
            const result = await writer.bulkWrite(operations, { ordered: false, ...(!nativeWrites ? { throwOnValidationError: true } : {}) });
            stats.inserted += result.upsertedCount || 0;
            stats.updated += result.modifiedCount || 0;
        }
        batch = [];
        await onProgress({ ...stats });
    }
    async function add(record) {
        record._DOL_ALTERNATE_RECORDS ||= [];
        record._DOL_DUPLICATE_RESOLUTION ||= null;
        stats.processed++;
        batch.push(record);
        if (batch.length >= batchSize) await flush();
    }
    for await (const item of records(filePath, { type, ensureActive })) {
        if (!item.record?.CASE_NUMBER) continue;
        const entry = audit.entries.get(item.record.CASE_NUMBER);
        if (!entry) continue;
        if (entry.alternates?.length) {
            if (entry.key === item.key || entry.alternates.some(other => other.key === item.key)) {
                const group = duplicates.get(item.record.CASE_NUMBER) || [];
                group.push({ row: item.key, data: item.record });
                duplicates.set(item.record.CASE_NUMBER, group);
            }
        } else if (entry.key === item.key) await add(item.record);
    }
    for (const [id, variants] of duplicates) {
        const entry = audit.entries.get(id);
        const primary = variants.find(variant => variant.row === entry.key).data;
        primary._DOL_ALTERNATE_RECORDS = variants.filter(variant => variant.row !== entry.key);
        primary._DOL_DUPLICATE_RESOLUTION = entry.sameEvent ? 'latest event, then explicit review dates, then first source row; same-event variants retained' : 'latest recorded decision event';
        await add(primary);
    }
    await flush();
    return stats;
}

module.exports = { VALIDATION_VERSION, sourceRank, auditWorkbook, importWorkbook, normalizeRecord, excelDateToJSDate };
