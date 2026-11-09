const { test } = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { randomUUID } = require('node:crypto');
const { programs, searchIndexes, indexOptions } = require('../services/searchConfig');
const { searchCases, countCases, invalidateCounts } = require('../services/caseSearch');
const { clearIndexHints } = require('../services/indexHints');
const { addWorksite } = require('../services/worksites');

const run = promisify(execFile);
const script = path.join(__dirname, '../scripts/compress-collections.js');
const compressors = async collection => {
    const [{ storageStats }] = await collection.aggregate([{ $collStats: { storageStats: { indexDetails: true } } }]).toArray();
    const of = details => details.creationString.match(/block_compressor=(\w*)/)[1];
    return { data: of(storageStats.wiredTiger), indexes: [...new Set(Object.values(storageStats.indexDetails).map(of))] };
};

test('case collections are rewritten with zstd without losing cases or indexes', { skip: !process.env.MONGO_TEST_URI }, async t => {
    const dbName = 'compresscol_' + randomUUID().replaceAll('-', '');
    const uri = `${process.env.MONGO_TEST_URI.replace(/\/$/, '')}/${dbName}`;
    const connection = await mongoose.createConnection(process.env.MONGO_TEST_URI, { dbName, autoIndex: false }).asPromise();
    t.after(async () => { invalidateCounts(); clearIndexHints(); await connection.dropDatabase(); await connection.close(); });
    const db = connection.db, models = {};
    for (const [program, config] of Object.entries(programs)) {
        const Model = connection.model(program, new mongoose.Schema({}, { strict: false }), config.collection); models[program] = Model;
        await Model.collection.createIndex({ CASE_NUMBER: 1 }, { unique: true });
        for (const index of searchIndexes(program)) await Model.collection.createIndex(index.key, indexOptions(index));
        await Model.collection.insertMany(Array.from({ length: 60 }, (_, i) => addWorksite({ CASE_NUMBER: `${program}-${i}`, [config.company]: i % 2 ? 'acme corp' : 'other inc',
            [config.employer]: 'ACME', JOB_TITLE_LOWER: 'engineer', [config.city]: 'austin', [config.state]: 'TX', WORKSITE_CITY: 'Seattle', WORKSITE_STATE: 'WA',
            PRIMARY_WORKSITE_CITY: 'Seattle', PRIMARY_WORKSITE_STATE: 'WA', [config.date]: new Date(Date.UTC(2024, 0, i + 1)), RECEIVED_DATE: new Date('2023-01-01'),
            CASE_STATUS: 'Certified', _DISCOVERY_VERSION: 1 }, program)));
        assert.equal((await compressors(Model.collection)).data, 'snappy');
    }
    const searches = async () => {
        clearIndexHints();
        for (const [program, config] of Object.entries(programs)) {
            assert.equal((await countCases(models[program], program, { company: 'acme' })).totalCount, 30);
            assert.equal((await searchCases(models[program], program, { worksiteState: 'WA', [config.year]: '2024', count: 'deferred' })).cases.length, 20);
            invalidateCounts();
        }
    };
    const indexSpecs = async () => Object.fromEntries(await Promise.all(Object.values(programs).map(async config =>
        [config.collection, (await db.collection(config.collection).indexes()).map(({ v, storageEngine, ...index }) => index).sort((a, b) => a.name.localeCompare(b.name))])));
    const before = await indexSpecs();

    // A running import blocks the rewrite and leaves the data untouched.
    await db.collection('import_locks').insertOne({ _id: 'case-import', owner: 'someone', label: 'Manual import', expiresAt: new Date(Date.now() + 60000) });
    await assert.rejects(run(process.execPath, [script], { env: { ...process.env, MONGO_URI: uri } }), /Another data import/);
    assert.equal((await compressors(models.h1b.collection)).data, 'snappy');
    await db.collection('import_locks').deleteMany({});

    const { stdout } = await run(process.execPath, [script], { env: { ...process.env, MONGO_URI: uri } });
    const events = stdout.trim().split('\n').filter(line => line.startsWith('{')).map(line => JSON.parse(line));
    assert.deepEqual(events.filter(event => event.event === 'swapped').map(event => event.program), ['perm', 'pwd', 'h1b']);
    for (const [program, config] of Object.entries(programs)) {
        assert.deepEqual(await compressors(models[program].collection), { data: 'zstd', indexes: ['zstd'] });
        assert.equal(await models[program].collection.countDocuments(), 60);
        await assert.rejects(models[program].collection.insertOne({ CASE_NUMBER: `${program}-0` }), { code: 11000 }, 'the unique case number index survives');
    }
    assert.deepEqual(await indexSpecs(), before, 'same indexes, keys and options');
    assert.deepEqual((await db.listCollections({}, { nameOnly: true }).toArray()).map(row => row.name).filter(name => name.endsWith('_zstd') || name.startsWith('tmp.')), []);
    assert.equal(await db.collection('import_locks').countDocuments({ expiresAt: { $gt: new Date() } }), 0, 'import lock released');
    assert.equal(await db.collection('discovery_locks').countDocuments({ expiresAt: { $gt: new Date() } }), 0, 'refresh lease released');
    await searches();

    // Re-running is a no-op.
    const again = await run(process.execPath, [script], { env: { ...process.env, MONGO_URI: uri } });
    assert.ok(!again.stdout.includes('"copying"'));
});
