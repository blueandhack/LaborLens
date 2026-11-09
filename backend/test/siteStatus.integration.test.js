const { test } = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const { randomUUID } = require('node:crypto');
const { programs } = require('../services/searchConfig');
const { refreshMap, invalidateMap } = require('../services/map');
const { createRunRecorder, getSiteStatus } = require('../services/siteStatus');

test('site status reports refresh runs, map builds and summaries', { skip: !process.env.MONGO_TEST_URI }, async t => {
    const connection = await mongoose.createConnection(process.env.MONGO_TEST_URI, { dbName: 'status_' + randomUUID().replaceAll('-', ''), autoIndex: false }).asPromise();
    t.after(async () => { invalidateMap(); await connection.dropDatabase(); await connection.close(); });
    const db = connection.db, models = {};
    for (const [program, config] of Object.entries(programs)) models[program] = connection.model(program, new mongoose.Schema({}, { strict: false }), config.collection);
    await models.pwd.collection.insertMany(Array.from({ length: 3 }, (_, i) => ({ CASE_NUMBER: 'P-' + i, PRIMARY_WORKSITE_POSTAL_CODE: '98101',
        PRIMARY_WORKSITE_STATE: 'WA', DETERMINATION_DATE: new Date('2025-01-01') })));

    // Before anything has run.
    let status = await getSiteStatus(db);
    assert.equal(status.refresh, null);
    assert.deepEqual(status.map.map(row => [row.program, row.cases, row.built, row.upToDate]), [['h1b', 0, null, false], ['perm', 0, null, false], ['pwd', 3, null, false]]);

    // A running refresh with a live lease, mid-way through the map step.
    await db.collection('discovery_locks').insertOne({ _id: 'refresh', owner: 'x', expiresAt: new Date(Date.now() + 60000) });
    const run = createRunRecorder(db, ['--map']);
    await run.start(); await run.step('Worksite map');
    await refreshMap(db, models, { onProgress: event => run.event(event) });
    status = await getSiteStatus(db);
    assert.equal(status.refresh.running, true); assert.equal(status.refresh.step, 'Worksite map'); assert.equal(status.refresh.interrupted, false);
    assert.ok(status.refresh.lastEvent?.event, 'progress is recorded');
    const pwd = status.map.find(row => row.program === 'pwd');
    assert.equal(pwd.build.state, 'ready'); assert.ok(pwd.build.durationMs >= 0);
    assert.equal(pwd.built.total, 3); assert.equal(pwd.built.metroLocated, 3); assert.deepEqual(pwd.built.years, [2025, 2025]);
    assert.equal(pwd.upToDate, true);

    await run.finish();
    status = await getSiteStatus(db);
    assert.equal(status.refresh.running, false); assert.equal(status.refresh.outcome, 'succeeded');
    assert.deepEqual(status.refresh.history.map(entry => [entry.outcome, entry.steps]), [['succeeded', ['Worksite map']]]);

    // New cases make the map out of date; a second run that dies leaves a stale "running" record.
    await models.pwd.collection.insertOne({ CASE_NUMBER: 'P-9', PRIMARY_WORKSITE_STATE: 'WA' });
    await db.collection('discovery_locks').deleteOne({ _id: 'refresh' });
    const failed = createRunRecorder(db, []);
    await failed.start(); await failed.step('Employer directory');
    status = await getSiteStatus(db);
    assert.equal(status.map.find(row => row.program === 'pwd').upToDate, false);
    assert.equal(status.refresh.interrupted, true, 'a run without a live lease is reported as interrupted');
    await failed.finish(new Error('boom'));
    status = await getSiteStatus(db);
    assert.deepEqual(status.refresh.history.map(entry => entry.outcome), ['failed', 'succeeded']);
    assert.equal(status.refresh.error, 'boom');
});
