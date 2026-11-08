const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const mongoose = require('mongoose');
const { programs } = require('../services/searchConfig');

test('index migration bootstraps empty program collections before their first import', { skip: !process.env.MONGO_TEST_URI }, async t => {
    const uri = new URL(process.env.MONGO_TEST_URI);
    uri.pathname = '/laborlens_index_test_' + randomUUID().replaceAll('-', '');
    const connection = await mongoose.createConnection(uri.href, { autoIndex: false }).asPromise();
    t.after(async () => { await connection.dropDatabase(); await connection.close(); });
    const run = promisify(execFile);
    const options = { env: { ...process.env, MONGO_URI: uri.href }, timeout: 30000 };
    const script = path.join(__dirname, '../scripts/search-indexes.js');
    await run(process.execPath, [script], options);
    await run(process.execPath, [script, '--check'], options);
    for (const config of Object.values(programs)) {
        const indexes = await connection.db.collection(config.collection).indexes();
        assert.equal(indexes.length, 12);
        assert.equal(indexes.find(index => index.name === 'CASE_NUMBER_1').unique, true);
        assert.equal(await connection.db.collection(config.collection).countDocuments(), 0);
    }
});
