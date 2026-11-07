const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const mongoose = require('mongoose');
const express = require('express');
const { searchIndexes } = require('../services/searchConfig');

test('H-1B HTTP search, year options, insights and details agree on application counts and program', { skip: !process.env.MONGO_TEST_URI }, async t => {
    const previousSecret = process.env.JWT_SECRET;
    process.env.JWT_SECRET = randomUUID();
    t.after(() => {
        if (previousSecret === undefined) delete process.env.JWT_SECRET;
        else process.env.JWT_SECRET = previousSecret;
    });
    await mongoose.connect(process.env.MONGO_TEST_URI, { dbName: 'laborlens_h1b_routes_' + randomUUID().replaceAll('-', ''), autoIndex: false });
    const models = require('../models/programModels');
    const app = express();
    app.use('/api/search', require('../routes/search').router);
    app.use('/api/cases', require('../routes/cases'));
    const server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    t.after(async () => {
        server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
        require('../routes/search').invalidateCache(); await mongoose.connection.dropDatabase(); await mongoose.disconnect();
    });
    await models.h1b.collection.createIndex({ CASE_NUMBER: 1 }, { unique: true });
    for (const index of searchIndexes('h1b')) await models.h1b.collection.createIndex(index.key, { name: index.name });
    const rows = [0, 1].map(i => ({ CASE_NUMBER: `I-200-26001-00000${i}`, VISA_CLASS: 'H-1B',
        EMPLOYER_NAME: 'Example LLC', EMPLOYER_NAME_LOWER: 'example llc', EMPLOYER_CITY_LOWER: 'austin', EMPLOYER_STATE: 'TX',
        JOB_TITLE: 'Engineer', JOB_TITLE_LOWER: 'engineer', DECISION_DATE: new Date('2026-01-07'), RECEIVED_DATE: new Date('2025-12-31'),
        CASE_STATUS: i ? 'Certified-Withdrawn' : 'Certified', TOTAL_WORKER_POSITIONS: 5, WAGE_RATE_OF_PAY_FROM: 60,
        ORIGINAL_CERT_DATE: i ? new Date('2026-01-05') : null,
        WAGE_UNIT_OF_PAY: 'Hour', _DOL_ALTERNATE_RECORDS: [{ data: { WORKSITE_CITY: 'Houston' } }] }));
    const inserted = await models.h1b.collection.insertMany(rows);
    async function get(path) {
        const response = await fetch(`http://127.0.0.1:${server.address().port}/api/${path}`);
        assert.equal(response.status, 200); return response.json();
    }
    const results = await get('search/h1b?company=EXAMPLE&decisionYear=2026&limit=1');
    assert.equal(results.totalCount, 2); assert.equal(results.cases.length, 1);
    assert.equal(results.cases[0].WAGE_RATE_OF_PAY_FROM, 60); assert.equal(results.cases[0].WAGE_UNIT_OF_PAY, 'Hour');
    assert.ok(Object.hasOwn(results.cases[0], 'ORIGINAL_CERT_DATE'));
    const withdrawn = await get('search/h1b?caseNumber=I-200-26001-000001');
    assert.equal(withdrawn.cases[0].ORIGINAL_CERT_DATE, '2026-01-05T00:00:00.000Z');
    assert.equal(results.cases[0]._DOL_ALTERNATE_RECORDS, undefined);
    assert.deepEqual(await get('search/h1b/years'), [2026, 2025]);
    const insights = await get('search/h1b/insights?company=example&page=200');
    assert.equal(insights.totalCount, 2); assert.deepEqual(insights.timeline, [{ year: 2026, count: 2 }]);
    assert.equal(insights.outcomes.length, 2);
    const detail = await get('cases/' + inserted.insertedIds[0]);
    assert.equal(detail._PROGRAM, 'h1b'); assert.equal(detail.TOTAL_WORKER_POSITIONS, 5);
    assert.equal(detail._DOL_ALTERNATE_RECORDS.length, 1);
});
