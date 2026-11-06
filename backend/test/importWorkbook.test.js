const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const ExcelJS = require('exceljs');
const { importWorkbook, excelDateToJSDate } = require('../services/importWorkbook');

async function fixture(t, type = 'pwd') {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'laborlens-workbook-test-'));
    t.after(() => fs.rm(dir, { recursive: true, force: true }));
    const file = path.join(dir, 'cases.xlsx');
    const workbook = new ExcelJS.Workbook();
    workbook.addWorksheet('Read me').addRow(['DOL disclosure data']);
    const sheet = workbook.addWorksheet('Cases');
    sheet.addRow(['Case disclosure data']);
    sheet.addRow(type === 'pwd'
        ? [' CASE_NUMBER ', 'EMPLOYER_LEGAL_BUSINESS_NAME', 'JOB_TITLE', 'EMPLOYER_CITY', 'DETERMINATION_DATE', 'RECEIVED_DATE']
        : ['CASE_NUMBER', 'EMP_BUSINESS_NAME', 'JOB_TITLE', 'EMP_CITY', 'DECISION_DATE', 'RECEIVED_DATE']);
    sheet.addRow(['A-1', { richText: [{ text: 'Example ' }, { text: 'INC' }] }, 'Engineer', 'Austin', 46023, new Date('2025-01-02T00:00:00Z')]);
    sheet.addRow([null, 'No case number']);
    sheet.addRow(['A-2', 'Other LLC', 'Analyst', 'Boston', null, 'not a date']);
    workbook.addWorksheet('Notes').addRow(['Not case data']);
    await workbook.xlsx.writeFile(file);
    return file;
}

for (const type of ['pwd', 'perm']) {
    test(`${type}: streams cover sheets, converts dates, normalizes search fields, and upserts by case number`, async t => {
        const file = await fixture(t, type);
        const records = new Map();
        const Model = {
            async bulkWrite(batch, options) {
                assert.equal(options.throwOnValidationError, true);
                let inserted = 0;
                for (const { updateOne } of batch) {
                    assert.equal(updateOne.upsert, true);
                    const key = updateOne.filter.CASE_NUMBER;
                    if (!records.has(key)) inserted++;
                    records.set(key, updateOne.update.$set);
                }
                return { upsertedCount: inserted, modifiedCount: batch.length - inserted };
            },
        };
        const first = await importWorkbook(file, { type, Model, batchSize: 1 });
        assert.deepEqual(first, { processed: 2, inserted: 2, updated: 0 });
        const second = await importWorkbook(file, { type, Model });
        assert.equal(second.inserted, 0);
        assert.equal(records.size, 2);
        const record = records.get('A-1');
        assert.equal(record[type === 'pwd' ? 'EMPLOYER_NAME_LOWER' : 'EMP_BUSINESS_NAME_LOWER'], 'example inc');
        assert.equal(record.JOB_TITLE_LOWER, 'engineer');
        assert.equal(record.RECEIVED_DATE.toISOString(), '2025-01-02T00:00:00.000Z');
        assert.equal(record[type === 'pwd' ? 'DETERMINATION_DATE' : 'DECISION_DATE'].toISOString(), '2026-01-01T00:00:00.000Z');
        assert.equal(records.get('A-2').RECEIVED_DATE, null);
    });
}

test('database failures propagate and stop later batches', async t => {
    const file = await fixture(t);
    let calls = 0;
    await assert.rejects(importWorkbook(file, {
        type: 'pwd', batchSize: 1,
        Model: { bulkWrite: async () => { calls++; throw new Error('database unavailable'); } },
    }), /database unavailable/);
    assert.equal(calls, 1);
});

test('wrong program headers cannot silently mark an empty import successful', async t => {
    const file = await fixture(t, 'perm');
    await assert.rejects(importWorkbook(file, {
        type: 'pwd', Model: { bulkWrite: async () => assert.fail('must not write') },
    }), /No PWD case rows/);
});

test('lost leases abort the import before it writes', async t => {
    const file = await fixture(t);
    await assert.rejects(importWorkbook(file, {
        type: 'pwd', Model: { bulkWrite: async () => assert.fail('must not write') },
        ensureActive: () => { throw new Error('lease lost'); },
    }), /lease lost/);
});

test('invalid dates and pre-1970 serials are discarded', () => {
    for (const value of [null, '', -1, 1, 'invalid', new Date('invalid')]) assert.equal(excelDateToJSDate(value), null);
});
