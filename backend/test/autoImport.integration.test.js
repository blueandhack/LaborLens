const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const { createHash, randomUUID } = require('crypto');
const mongoose = require('mongoose');
const ExcelJS = require('exceljs');
const { acquireImportLock } = require('../services/importLock');
const { runAutoImport } = require('../services/autoImport');
const { importWorkbook } = require('../services/importWorkbook');

test('MongoDB import integration', { skip: !process.env.MONGO_TEST_URI }, async t => {
    // Always create a new test database; never drop a database named by the URI.
    const name = 'laborlens_import_test_' + randomUUID().replaceAll('-', '');
    await mongoose.connect(process.env.MONGO_TEST_URI, { dbName: name, autoIndex: false });
    const db = mongoose.connection.db;
    const models = { pwd: require('../models/Case'), perm: require('../models/PermCase') };
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'laborlens-integration-'));
    t.after(async () => {
        await db.dropDatabase();
        await mongoose.disconnect();
        await fs.rm(dir, { recursive: true, force: true });
    });
    for (const Model of Object.values(models)) await Model.collection.createIndex({ CASE_NUMBER: 1 }, { unique: true });

    await t.test('manual and automatic work cannot hold the import lease concurrently', async () => {
        const first = await acquireImportLock(db, 'manual');
        await assert.rejects(acquireImportLock(db, 'automatic'), error => error.status === 409);
        await first.release();
        const second = await acquireImportLock(db, 'automatic');
        await second.release();
        assert.equal(await db.collection('import_locks').countDocuments(), 0);
    });

    await t.test('expired leases can be reclaimed without the old owner deleting the new lease', async () => {
        const first = await acquireImportLock(db, 'abandoned', { heartbeatMs: 5 });
        await db.collection('import_locks').updateOne({ _id: 'case-import' }, { $set: { expiresAt: new Date(0) } });
        const second = await acquireImportLock(db, 'replacement');
        await new Promise(resolve => setTimeout(resolve, 30));
        assert.throws(first.ensureActive, /lease expired|lease.*lost/);
        await first.release();
        assert.equal((await db.collection('import_locks').findOne({ _id: 'case-import' })).label, 'replacement');
        await second.release();
    });

    const datasets = ['pwd', 'perm'].map(type => ({
        type, fiscalYear: 2026, quarter: 3, filename: `${type}.xlsx`,
        url: `https://www.dol.gov/media/${type}.xlsx`,
    }));
    const files = {};
    async function writeFile(type, extra = false) {
        const workbook = new ExcelJS.Workbook();
        const sheet = workbook.addWorksheet('Cases');
        sheet.addRow(type === 'pwd'
            ? ['CASE_NUMBER', 'EMPLOYER_LEGAL_BUSINESS_NAME', 'JOB_TITLE', 'DETERMINATION_DATE']
            : ['CASE_NUMBER', 'EMP_BUSINESS_NAME', 'JOB_TITLE', 'DECISION_DATE']);
        sheet.addRow([type + '-1', extra ? 'Corrected employer' : 'Initial employer', 'Engineer', 46023]);
        sheet.addRow([type + '-2', 'Second employer', 'Analyst', 46024]);
        if (extra) sheet.addRow([type + '-3', 'New employer', 'Manager', 46025]);
        const file = path.join(dir, type + '.xlsx');
        await workbook.xlsx.writeFile(file);
        files[type] = await fs.readFile(file);
    }
    await writeFile('pwd');
    await writeFile('perm');
    let downloadCalls = [];
    const options = {
        models, discover: async () => datasets, log: () => {},
        download: async (dataset, destination, previous, { force }) => {
            downloadCalls.push({ type: dataset.type, previous });
            const bytes = files[dataset.type];
            const sha256 = createHash('sha256').update(bytes).digest('hex');
            if (!force && previous?.sha256 === sha256) return { unchanged: true };
            await fs.writeFile(destination, bytes);
            return { unchanged: false, sha256, bytes: bytes.length, etag: sha256 };
        },
    };

    await t.test('imports both programs, persists history, and skips successfully imported bytes', async () => {
        const first = await runAutoImport(db, options);
        assert.equal(first.results.length, 2);
        assert.equal(first.results[0].inserted, 2);
        assert.equal(first.results[1].inserted, 2);
        const second = await runAutoImport(db, options);
        assert.deepEqual(second.results.map(result => result.outcome), ['unchanged', 'unchanged']);
        assert.equal(await models.pwd.countDocuments(), 2);
        assert.equal(await models.perm.countDocuments(), 2);
        assert.equal(await db.collection('import_runs').countDocuments({ status: 'done' }), 2);
    });

    await t.test('partial database failure is recorded, then replayed without duplicating cases', async () => {
        await writeFile('pwd', true);
        await assert.rejects(runAutoImport(db, {
            ...options,
            importFile: async (file, config) => importWorkbook(file, {
                ...config, batchSize: 1,
                Model: { bulkWrite: async (batch, writeOptions) => {
                    await models.pwd.bulkWrite(batch, writeOptions);
                    throw new Error('simulated failure after a committed batch');
                } },
            }),
        }), /simulated failure/);
        assert.equal((await db.collection('import_sources').findOne({ type: 'pwd' })).status, 'error');
        assert.equal(await db.collection('import_locks').countDocuments(), 0);
        downloadCalls = [];
        const retried = await runAutoImport(db, options);
        assert.equal(downloadCalls[0].previous, null, 'a partial import cannot use old cache validators');
        assert.equal(retried.results[0].outcome, 'imported');
        assert.equal(await models.pwd.countDocuments(), 3);
        assert.equal((await models.pwd.findOne({ CASE_NUMBER: 'pwd-1' })).EMPLOYER_LEGAL_BUSINESS_NAME, 'Corrected employer');
    });

    await t.test('force imports unchanged files for recovery/backfill', async () => {
        const replayed = await runAutoImport(db, { ...options, force: true });
        assert.deepEqual(replayed.results.map(result => result.outcome), ['imported', 'imported']);
        assert.equal(await models.pwd.countDocuments(), 3);
    });

    await t.test('an older release cannot replace a newer successful release', async () => {
        await db.collection('import_sources').insertOne({ _id: 'future-release', type: 'pwd', fiscalYear: 2027, quarter: 1, completedAt: new Date() });
        await assert.rejects(runAutoImport(db, options), /superseded DOL release/);
        assert.equal(await db.collection('import_locks').countDocuments(), 0);
    });
});
