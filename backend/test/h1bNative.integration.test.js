const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const mongoose = require('mongoose');
const ExcelJS = require('exceljs');
const { importWorkbook } = require('../services/importWorkbook');

test('native H-1B upserts preserve canonical types, case IDs and creation times across replay', { skip: !process.env.MONGO_TEST_URI }, async t => {
    const connection = await mongoose.createConnection(process.env.MONGO_TEST_URI, {
        dbName: 'laborlens_h1b_native_' + randomUUID().replaceAll('-', ''), autoIndex: false,
    }).asPromise();
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'laborlens-native-h1b-'));
    t.after(async () => { await connection.dropDatabase(); await connection.close(); await fs.rm(directory, { recursive: true, force: true }); });
    const Model = connection.model('NativeH1b', require('../models/H1bCase').schema, 'h1bcases');
    await Model.collection.createIndex({ CASE_NUMBER: 1 }, { unique: true });
    const workbook = new ExcelJS.Workbook(); const sheet = workbook.addWorksheet('LCA');
    sheet.addRow(['CASE_NUMBER', 'VISA_CLASS', 'EMPLOYER_NAME', 'DECISION_DATE', 'RECEIVED_DATE',
        'WAGE_RATE_OF_PAY_FROM', 'WAGE_RATE_OF_PAY_TO', 'WAGE_UNIT_OF_PAY', 'JOB_TITLE', 'TOTAL_WORKER_POSITIONS']);
    sheet.addRow(['I-200-000001', 'H-1B', ' Example LLC ', new Date('2026-01-07'), new Date('2025-12-31'), '60.50', '70.25', 'Hour', 'Engineer', '3']);
    const file = path.join(directory, 'lca.xlsx'); await workbook.xlsx.writeFile(file);
    assert.equal((await importWorkbook(file, { type: 'h1b', Model })).inserted, 1);
    const first = await Model.collection.findOne({ CASE_NUMBER: 'I-200-000001' });
    assert.equal(first.EMPLOYER_NAME, 'Example LLC'); assert.equal(first.EMPLOYER_NAME_LOWER, 'example llc');
    assert.equal(first.WAGE_RATE_OF_PAY_FROM, 60.5); assert.equal(first.WAGE_RATE_OF_PAY_TO, 70.25);
    assert.equal(first.TOTAL_WORKER_POSITIONS, 3); assert.equal(first.WAGE_UNIT_OF_PAY, 'Hour');
    assert.ok(first.DECISION_DATE instanceof Date && first.RECEIVED_DATE instanceof Date);
    assert.ok(first.createdAt instanceof Date && first.updatedAt instanceof Date);
    assert.equal((await importWorkbook(file, { type: 'h1b', Model })).inserted, 0);
    const replay = await Model.collection.findOne({ CASE_NUMBER: first.CASE_NUMBER });
    assert.equal(String(replay._id), String(first._id));
    assert.equal(replay.createdAt.getTime(), first.createdAt.getTime());
    assert.ok(replay.updatedAt >= first.updatedAt);
    assert.equal(await Model.collection.countDocuments({}), 1);
});
