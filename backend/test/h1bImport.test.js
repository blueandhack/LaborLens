const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const ExcelJS = require('exceljs');
const { discoverDatasets } = require('../services/dolSource');
const { auditWorkbook, importWorkbook } = require('../services/importWorkbook');

test('H-1B discovery selects the newest cumulative LCA main file only, including DOL spelling variants', () => {
    const names = ['LCA_Disclosure_Data_FY2026_Q2.xlsx', 'LCA_Dislclosure_Data_FY2026_Q3.xlsx',
        'LCA_Appendix_A_FY2026_Q3.xlsx', 'LCA_Worksites_FY2026_Q3.xlsx', 'LCA_Record_Layout_FY2026_Q3.pdf'];
    const files = discoverDatasets(names.map(name => `<a href="/media/${name}">file</a>`).join(''), { programs: ['h1b'] });
    assert.equal(files.length, 1);
    assert.equal(files[0].type, 'h1b'); assert.equal(files[0].quarter, 3);
    assert.throws(() => discoverDatasets('', { programs: ['h1b'] }), /no supported H1B/);
    assert.throws(() => discoverDatasets('', { programs: ['other'] }), /Invalid disclosure programs/);
});

test('H-1B importer excludes H-1B1/E-3, retains wage periods and variants, and rejects uncertain visa classes before writes', async t => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'laborlens-h1b-test-'));
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    const file = path.join(directory, 'h1b.xlsx');
    const workbook = new ExcelJS.Workbook(); const sheet = workbook.addWorksheet('LCA');
    sheet.addRow(['CASE_NUMBER', 'CASE_STATUS', 'VISA_CLASS', 'EMPLOYER_NAME', 'EMPLOYER_CITY', 'EMPLOYER_STATE',
        'JOB_TITLE', 'SOC_CODE', 'DECISION_DATE', 'RECEIVED_DATE', 'WAGE_RATE_OF_PAY_FROM', 'WAGE_RATE_OF_PAY_TO',
        'WAGE_UNIT_OF_PAY', 'TOTAL_WORKER_POSITIONS', 'WORKSITE_CITY']);
    const base = ['I-200-26001-000001', 'Certified-Withdrawn', 'H-1B', 'Example LLC', 'Austin', 'TX',
        'Software Engineer', '15-1252', new Date('2026-02-01'), new Date('2026-01-01'), '120,000', 150000, 'Year', 5, 'Dallas'];
    sheet.addRow(base); sheet.addRow([...base.slice(0, 14), 'Houston']);
    sheet.addRow(['I-200-26001-000002', 'Certified', 'H-1B1 Chile', ...base.slice(3)]);
    sheet.addRow(['I-200-26001-000003', 'Certified', 'E-3 Australian', ...base.slice(3)]);
    sheet.addRow(['I-200-26001-000004', 'Denied', 'H1B', ...base.slice(3, 10), '60.50', null, 'Hour', 1, 'Dallas']);
    await workbook.xlsx.writeFile(file);
    const audit = await auditWorkbook(file, { type: 'h1b' });
    assert.equal(audit.report.uniqueCases, 2); assert.equal(audit.report.excludedRows, 2);
    assert.equal(audit.report.duplicateRows, 1);
    const rows = [];
    const Model = { bulkWrite: async operations => { rows.push(...operations.map(op => op.updateOne.update.$set)); return { upsertedCount: operations.length }; } };
    const stats = await importWorkbook(file, { type: 'h1b', Model, validation: audit });
    assert.equal(stats.inserted, 2);
    const first = rows.find(row => row.CASE_NUMBER === base[0]);
    assert.equal(first.WAGE_RATE_OF_PAY_FROM, 120000); assert.equal(first.WAGE_UNIT_OF_PAY, 'Year');
    assert.equal(first.TOTAL_WORKER_POSITIONS, 5); assert.equal(first.PWD_SOC_CODE, '15-1252');
    assert.equal(first.EMPLOYER_NAME_LOWER, 'example llc'); assert.equal(first.EMPLOYER_CITY_LOWER, 'austin');
    assert.equal(first.DECISION_DATE.toISOString(), '2026-02-01T00:00:00.000Z');
    assert.equal(first._DOL_ALTERNATE_RECORDS.length, 1);
    assert.equal(rows.find(row => row.CASE_NUMBER.endsWith('4')).WAGE_RATE_OF_PAY_FROM, 60.5);
    sheet.addRow(['I-200-26001-000005', 'Certified', null, ...base.slice(3)]);
    await workbook.xlsx.writeFile(file);
    await assert.rejects(importWorkbook(file, { type: 'h1b', Model: { bulkWrite: () => assert.fail('must not write') } }), /without VISA_CLASS/);
});
