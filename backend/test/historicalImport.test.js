const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const ExcelJS = require('exceljs');
const { buildLayout, normalizeRecord, excelDateToJSDate, parseNumber } = require('../services/dolLayout');
const { auditWorkbook, importWorkbook } = require('../services/importWorkbook');
const { discoverDatasets } = require('../services/dolSource');

async function workbook(t, sheets, { date1904 = false } = {}) {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'laborlens-legacy-'));
    t.after(() => fs.rm(dir, { force: true, recursive: true }));
    const book = new ExcelJS.Workbook();
    book.properties.date1904 = date1904;
    for (const [name, rows] of Object.entries(sheets)) book.addWorksheet(name).addRows(rows);
    const file = path.join(dir, 'archive.xlsx');
    await book.xlsx.writeFile(file);
    return file;
}

test('archive discovery covers two-digit FY names, PWD 2018, legacy filenames, and latest form variants', () => {
    const html = ['PERM_FY2008.xlsx', 'PERM_FY2009.xlsx', 'PERM_Disclosure_Data_FY15_Q4.xlsx',
        'PERM_Disclosure_Data_FY2026_Q3.xlsx', 'PW_FY2010.xlsx', 'PW_Case_Data_FY2014.xlsx',
        'PWD_Disclosure_Data_FY2018_EOY.xlsx', 'PW_Disclosure_Data_FY2023_Q3_old_form.xlsx',
        'PW_Disclosure_Data_FY2023_Q4_old_form.xlsx', 'PW_Disclosure_Data_FY2023_Q4_revised_form.xlsx',
        'PW_Disclosure_Data_FY2026_Q3.xlsx', 'PW_Worksites_FY2026_Q3.xlsx'].map(file => `<a href="/media/${file}">file</a>`).join('');
    const all = discoverDatasets(html, { fromYear: 2008 });
    assert.equal(all.length, 10);
    assert.ok(all.some(file => file.type === 'pwd' && file.fiscalYear === 2018));
    assert.ok(all.some(file => file.fiscalYear === 2015 && file.quarter === 4));
    assert.equal(all.filter(file => file.fiscalYear === 2023).length, 2);
    assert.equal(discoverDatasets(html).length, 2);
});

test('FY2009 spaced PERM headers map wages, names, and dates without inventing received dates', () => {
    const headers = ['CASE_NUMBER', 'EMPLOYER NAME', 'DECISION DATE', 'EMPLOYER CITY', 'PW JOB TITLE 9089', 'WAGE OFFER FROM 9089', 'WAGE OFFER UNIT OF PAY 9089'];
    const layout = buildLayout(headers, 'perm');
    const record = Object.fromEntries(layout.headers.map((field, i) => [field, ['A-1', 'Old Employer', 39800, 'Boston', 'Engineer', '$60,000.00', 'YR'][i]]));
    normalizeRecord(record, 'perm', { layout });
    assert.equal(record.EMP_BUSINESS_NAME, 'Old Employer');
    assert.equal(record.JOB_TITLE, 'Engineer');
    assert.equal(record.JOB_OPP_WAGE_FROM, 60000);
    assert.equal(record.JOB_OPP_WAGE_PER, 'Year');
    assert.ok(record.DECISION_DATE instanceof Date);
    assert.equal(record.RECEIVED_DATE, null);
    assert.equal(record.EMP_BUSINESS_NAME_LOWER, 'old employer');
});

test('FY2012 PWD spelling error and FY2013 PERM title correction have explicit mappings', () => {
    const pwd = buildLayout(['CASE_NUMBER', 'EMPLYER_LEGAL_BUSINESS_NAME', 'PW_DETERMINATION_DATE'], 'pwd');
    const record = { CASE_NUMBER: 'P-1', EMPLYER_LEGAL_BUSINESS_NAME: 'Example', PW_DETERMINATION_DATE: 41000 };
    normalizeRecord(record, 'pwd', { layout: pwd });
    assert.equal(record.EMPLOYER_LEGAL_BUSINESS_NAME, 'Example');
    assert.ok(record.DETERMINATION_DATE instanceof Date);
    const perm = buildLayout(['CASE_NO', 'EMPLOYER_NAME', 'ADD_THESE_PW_JOB_TITLE_9089', 'PW_JOB_TITLE_9089'], 'perm');
    const old = { CASE_NO: 'A-1', EMPLOYER_NAME: 'Example', ADD_THESE_PW_JOB_TITLE_9089: 'Production Supervisor', PW_JOB_TITLE_9089: 'SOC occupation' };
    normalizeRecord(old, 'perm', { layout: perm });
    assert.equal(old.JOB_TITLE, 'Production Supervisor');
    assert.equal(old.JOB_OPP_WAGE_PER, null);
    assert.equal(old.PW_JOB_TITLE_9089, 'SOC occupation');
});

test('invalid optional data becomes null with original values retained', () => {
    const issues = [];
    const record = { CASE_NUMBER: 'P-1', PWD_WAGE_RATE: '#############', DETERMINATION_DATE: '2024-02-30' };
    normalizeRecord(record, 'pwd', { issues });
    assert.equal(record.PWD_WAGE_RATE, null);
    assert.equal(record.DETERMINATION_DATE, null);
    assert.equal(record._DOL_RAW_VALUES.PWD_WAGE_RATE, '#############');
    assert.equal(issues.length, 2);
    assert.equal(parseNumber('.00'), 0);
    assert.equal(parseNumber('$1,234.56'), 1234.56);
    assert.equal(parseNumber('12,34'), null);
});

test('a whole-file preflight prevents partial writes when a later row has no identifier', async t => {
    const file = await workbook(t, { Cases: [
        ['CASE_NO', 'EMPLOYER_NAME', 'DECISION_DATE'], ['A-1', 'Valid', 41000], [null, 'Missing ID', 41000],
    ] });
    let writes = 0;
    await assert.rejects(importWorkbook(file, { type: 'perm', batchSize: 1, Model: { bulkWrite: async () => { writes++; } } }), /without a case number/);
    assert.equal(writes, 0);
});

test('duplicate case events select the latest date and preserve distinct original variants', async t => {
    const file = await workbook(t, { Cases: [
        ['CASE_NUMBER', 'EMPLOYER_LEGAL_BUSINESS_NAME', 'PW_DETERMINATION_DATE', 'PW_REDETERMINATION_DATE', 'PWD_WAGE_RATE'],
        ['P-1', 'Employer', 41000, null, 100], ['P-1', 'Employer', 41000, 41010, 150],
        ['P-1', 'Employer', 41000, 41010, 150],
    ] });
    const audit = await auditWorkbook(file, { type: 'pwd' });
    assert.equal(audit.report.duplicateRows, 2);
    assert.equal(audit.report.identicalDuplicates, 1);
    const writes = [];
    await importWorkbook(file, { type: 'pwd', validation: audit, Model: { bulkWrite: async batch => { writes.push(...batch); return { upsertedCount: batch.length }; } } });
    assert.equal(writes.length, 1);
    const record = writes[0].updateOne.update.$set;
    assert.equal(record.PWD_WAGE_RATE, 150);
    assert.equal(record._DOL_ALTERNATE_RECORDS.length, 1);
    assert.equal(record._DOL_ALTERNATE_RECORDS[0].data.PWD_WAGE_RATE, 100);
});

test('same-event multi-worksite variants and multiple data sheets are retained', async t => {
    const headers = ['CASE_NUMBER', 'EMPLOYER_LEGAL_BUSINESS_NAME', 'DETERMINATION_DATE', 'PRIMARY_WORKSITE_CITY'];
    const file = await workbook(t, { One: [headers, ['P-1', 'Employer', 41000, 'Boston']], Two: [headers, ['P-1', 'Employer', 41000, 'Austin'], ['P-2', 'Other', 41000, 'Chicago']] });
    const audit = await auditWorkbook(file, { type: 'pwd' });
    assert.equal(audit.report.layouts.length, 2);
    assert.equal(audit.report.uniqueCases, 2);
    assert.equal(audit.report.sameEventVariantCases, 1);
});

test('1904 date systems and postal-code zero padding are respected', async t => {
    assert.equal(excelDateToJSDate(44561, { date1904: true }).toISOString(), '2026-01-01T00:00:00.000Z');
    const file = await workbook(t, { Cases: [['CASE_NUMBER', 'EMPLOYER_LEGAL_BUSINESS_NAME', 'DETERMINATION_DATE'], ['P-1', 'Employer', new Date('2026-01-01T00:00:00Z')]] }, { date1904: true });
    const records = [];
    await importWorkbook(file, { type: 'pwd', Model: { bulkWrite: async batch => { records.push(...batch); return {}; } } });
    assert.equal(records[0].updateOne.update.$set.DETERMINATION_DATE.toISOString(), '2026-01-01T00:00:00.000Z');
    const book = new ExcelJS.Workbook();
    const sheet = book.addWorksheet('Cases');
    sheet.addRow(['CASE_NUMBER', 'EMPLOYER_LEGAL_BUSINESS_NAME', 'EMPLOYER_POSTAL_CODE']);
    sheet.addRow(['P-2', 'Employer', 1234]);
    sheet.getCell('C2').numFmt = '00000';
    await book.xlsx.writeFile(file);
    const padded = [];
    await importWorkbook(file, { type: 'pwd', Model: { bulkWrite: async batch => { padded.push(...batch); return {}; } } });
    assert.equal(padded[0].updateOne.update.$set.EMPLOYER_POSTAL_CODE, '01234');
});

test('the compact shared-string cache preserves Unicode across eviction and index blocks', async t => {
    const rows = [['CASE_NUMBER', 'EMPLOYER_LEGAL_BUSINESS_NAME', 'JOB_TITLE', 'EMPLOYER_CITY']];
    for (let i = 0; i < 20000; i++) rows.push([`P-${i}`, `Employer ${i} & Co`, `工程師 🚀 ${i}`, `City ${i}`]);
    const file = await workbook(t, { Cases: rows });
    let count = 0;
    let last;
    await importWorkbook(file, { type: 'pwd', Model: { bulkWrite: async batch => {
        count += batch.length;
        last = batch[batch.length - 1].updateOne.update.$set;
        return { upsertedCount: batch.length };
    } } });
    assert.equal(count, 20000);
    assert.equal(last.CASE_NUMBER, 'P-19999');
    assert.equal(last.JOB_TITLE, '工程師 🚀 19999');
    assert.equal(last.EMPLOYER_LEGAL_BUSINESS_NAME, 'Employer 19999 & Co');
});
