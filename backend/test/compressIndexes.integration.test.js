const { test } = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { randomUUID } = require('node:crypto');
const { programs, searchIndexes, legacyIndexNames, indexNames } = require('../services/searchConfig');
const { searchCases, countCases, invalidateCounts } = require('../services/caseSearch');
const { hintFor, clearIndexHints, ensureSearchIndex } = require('../services/indexHints');
const { addWorksite } = require('../services/worksites');

test('compressed search indexes replace the previous versions without failing searches', { skip: !process.env.MONGO_TEST_URI }, async t => {
    const dbName = 'compress_' + randomUUID().replaceAll('-', '');
    const connection = await mongoose.createConnection(process.env.MONGO_TEST_URI, { dbName, autoIndex: false }).asPromise();
    t.after(async () => { invalidateCounts(); clearIndexHints(); await connection.dropDatabase(); await connection.close(); });
    const models = {};
    for (const [program, config] of Object.entries(programs)) {
        const Model = connection.model(program, new mongoose.Schema({}, { strict: false }), config.collection); models[program] = Model;
        await Model.collection.createIndex({ CASE_NUMBER: 1 }, { unique: true });
        // The previous, uncompressed versions: old names and keys.
        for (const index of searchIndexes(program)) {
            const { _ZSTD_INDEX, ...key } = index.key;
            await Model.collection.createIndex(key, { name: legacyIndexNames[index.name], ...(index.partialFilterExpression ? { partialFilterExpression: index.partialFilterExpression } : {}) });
        }
        await Model.collection.insertMany(Array.from({ length: 60 }, (_, i) => addWorksite({ CASE_NUMBER: `${program}-${i}`, [config.company]: i % 2 ? 'acme corp' : 'other inc',
            [config.employer]: 'ACME', JOB_TITLE_LOWER: 'engineer', [config.city]: 'austin', [config.state]: 'TX', WORKSITE_CITY: 'Seattle', WORKSITE_STATE: 'WA',
            PRIMARY_WORKSITE_CITY: 'Seattle', PRIMARY_WORKSITE_STATE: 'WA', [config.date]: new Date(Date.UTC(2024, 0, i + 1)), RECEIVED_DATE: new Date('2023-01-01'),
            CASE_STATUS: 'Certified', _DISCOVERY_VERSION: 1 }, program)));
    }
    const searches = async () => {
        clearIndexHints();
        for (const [program, config] of Object.entries(programs)) {
            assert.equal((await countCases(models[program], program, { company: 'acme' })).totalCount, 30);
            assert.equal((await searchCases(models[program], program, { worksiteState: 'WA', [config.year]: '2024', count: 'deferred' })).cases.length, 20);
            assert.equal((await searchCases(models[program], program, { jobTitle: 'eng', location: 'tx' })).totalCount, 60);
            invalidateCounts();
        }
    };

    assert.equal(await hintFor(models.h1b.collection, indexNames.company), 'search_company_v3', 'previous versions are hinted until replaced');
    assert.equal(await ensureSearchIndex(models.h1b.collection, searchIndexes('h1b').find(index => index.name === indexNames.company)), 'awaiting-replacement');
    await searches();

    const run = promisify(execFile);
    const { stdout } = await run(process.execPath, [path.join(__dirname, '../scripts/compress-indexes.js')], {
        env: { ...process.env, MONGO_URI: `${process.env.MONGO_TEST_URI.replace(/\/$/, '')}/${dbName}`, INDEX_SWITCH_WAIT_MS: '0' } });
    const events = stdout.trim().split('\n').filter(line => line.startsWith('{')).map(line => JSON.parse(line));
    assert.equal(events.filter(event => event.event === 'dropped').length, searchIndexes('h1b').length + searchIndexes('perm').length + searchIndexes('pwd').length);
    for (const [program, config] of Object.entries(programs)) {
        const indexes = await connection.db.collection(config.collection).indexes();
        assert.deepEqual(indexes.map(index => index.name).sort(), ['CASE_NUMBER_1', '_id_', ...searchIndexes(program).map(index => index.name)].sort());
        assert.ok(indexes.filter(index => index.name.startsWith('search_')).every(index => index.storageEngine?.wiredTiger?.configString === 'block_compressor=zstd'));
    }
    clearIndexHints();
    assert.equal(await hintFor(models.h1b.collection, indexNames.company), 'search_company_v4');
    await searches();
    // Re-running is a no-op.
    const again = await run(process.execPath, [path.join(__dirname, '../scripts/compress-indexes.js')], {
        env: { ...process.env, MONGO_URI: `${process.env.MONGO_TEST_URI.replace(/\/$/, '')}/${dbName}`, INDEX_SWITCH_WAIT_MS: '0' } });
    assert.ok(!again.stdout.includes('"building"'));
});
