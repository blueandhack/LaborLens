const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const mongoose = require('mongoose');
const express = require('express');
const jwt = require('jsonwebtoken');

test('authenticated import status reports live program and quarterly coverage without losing older sources', { skip: !process.env.MONGO_TEST_URI }, async t => {
    const previousSecret = process.env.JWT_SECRET;
    process.env.JWT_SECRET = randomUUID();
    await mongoose.connect(process.env.MONGO_TEST_URI, { dbName: 'laborlens_import_status_' + randomUUID().replaceAll('-', ''), autoIndex: false });
    const app = express(); app.use('/api/upload', require('../routes/upload'));
    const server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    t.after(async () => {
        server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
        await mongoose.connection.dropDatabase(); await mongoose.disconnect();
        if (previousSecret === undefined) delete process.env.JWT_SECRET; else process.env.JWT_SECRET = previousSecret;
    });
    const db = mongoose.connection.db;
    const q4 = { type: 'h1b', fiscalYear: 2021, quarter: 4, filename: 'LCA_Disclosure_Data_FY2021_Q4.xlsx', url: 'https://www.dol.gov/q4.xlsx' };
    const q1 = { ...q4, quarter: 1, filename: 'LCA_Disclosure_Data_FY2021_Q1.xlsx', url: 'https://www.dol.gov/q1.xlsx' };
    const current = { type: 'pwd', fiscalYear: 2026, quarter: 3, filename: 'PW_Disclosure_Data_FY2026_Q3.xlsx', url: 'https://www.dol.gov/pwd.xlsx' };
    await db.collection('import_catalog').insertOne({ _id: 'dol', fromYear: 2021, datasets: [q4, current], releases: [q1, q4, current], releasesCheckedAt: new Date() });
    await db.collection('import_sources').insertMany([
        { _id: 'h1b-complete', ...q4, status: 'done', validation: { version: 2, canImport: true, uniqueCases: 100 } },
        { _id: 'pwd-current', ...current, status: 'importing', runId: 'active-run', progress: { processed: 25 }, validation: { version: 2, canImport: true, uniqueCases: 100 } },
    ]);
    await db.collection('import_runs').insertOne({ _id: 'active-run', status: 'running', startedAt: new Date('2026-01-01') });
    // The active job can be older than the five most recent deferred checks.
    await db.collection('import_runs').insertMany(Array.from({ length: 6 }, (_, i) => ({ _id: `deferred-${i}`, status: 'busy', startedAt: new Date(Date.UTC(2026, 1, i + 1)), error: 'Another import is running' })));
    await db.collection('import_locks').insertOne({ _id: 'case-import', runId: 'active-run', expiresAt: new Date(Date.now() + 300000) });
    const endpoint = `http://127.0.0.1:${server.address().port}/api/upload/auto/status`;
    assert.equal((await fetch(endpoint)).status, 401);
    const token = jwt.sign({ id: 'test-admin' }, process.env.JWT_SECRET, { expiresIn: '5m' });
    const response = await fetch(endpoint, { headers: { Authorization: `Bearer ${token}` } });
    assert.equal(response.status, 200);
    const data = await response.json();
    assert.equal(data.currentRun._id, 'active-run');
    const h1b = data.progress.programs.find(program => program.type === 'h1b');
    assert.equal(h1b.completedFiles, 1);
    assert.equal(h1b.years.find(year => year.fiscalYear === 2021).quarters[0].state, 'covered');
    assert.equal(h1b.years.find(year => year.fiscalYear === 2021).quarters[3].state, 'imported');
    const pwd = data.progress.programs.find(program => program.type === 'pwd');
    assert.equal(pwd.current[0].percentage, 25);
    assert.equal(data.sources.find(source => source._id === 'pwd-current').quarter, 3);
    assert.equal(data.progress.programs.find(program => program.type === 'perm').inventoryKnown, false);
    await db.collection('import_locks').deleteOne({ _id: 'case-import' });
    const expired = await (await fetch(endpoint, { headers: { Authorization: `Bearer ${token}` } })).json();
    assert.equal(expired.sources.find(source => source._id === 'pwd-current').status, 'interrupted');
    const interrupted = expired.progress.programs.find(program => program.type === 'pwd');
    assert.equal(interrupted.current.length, 0);
    assert.equal(interrupted.attentionFiles, 1);
});
