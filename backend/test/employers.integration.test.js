const { test } = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const express = require('express');
const { randomUUID } = require('node:crypto');
const { programs, searchIndexes } = require('../services/searchConfig');
const { addWorksite, normalizeWorksites } = require('../services/worksites');
const { refreshDirectory, suggestions, computeProfile, getProfile, slugFor } = require('../services/employers');
const { searchCases, countCases, buildSearch, invalidateCounts } = require('../services/caseSearch');
const { computeInsights } = require('../services/searchInsights');
const { createEmployerRoutes } = require('../routes/employers');

test('employer directory, profiles and indexed worksite search preserve identity and source semantics', { skip: !process.env.MONGO_TEST_URI }, async t => {
    const connection = await mongoose.createConnection(process.env.MONGO_TEST_URI, { dbName: 'employers_' + randomUUID().replaceAll('-', ''), autoIndex: false }).asPromise();
    const models = {};
    t.after(async () => { invalidateCounts(); await connection.dropDatabase(); await connection.close(); });
    for (const [program, config] of Object.entries(programs)) {
        const Model = connection.model(program, new mongoose.Schema({}, { strict: false }), config.collection); models[program] = Model;
        for (const index of searchIndexes(program)) await Model.collection.createIndex(index.key, { name: index.name, ...(index.partialFilterExpression ? { partialFilterExpression: index.partialFilterExpression } : {}) });
        const rows = Array.from({ length: 32 }, (_, i) => {
            const name = i < 30 ? 'Synthropic, Inc.' : 'Synthropic INC';
            const city = i % 2 ? 'San Francisco' : 'California City', state = 'CA';
            return addWorksite({ CASE_NUMBER: `${program}-${i}`, [config.employer]: name, [config.company]: name.toLowerCase(),
                [config.city]: 'austin', [config.state]: 'TX', EMPLOYER_CITY: 'Austin', EMP_CITY: 'Austin',
                WORKSITE_CITY: city, WORKSITE_STATE: state, PRIMARY_WORKSITE_CITY: city, PRIMARY_WORKSITE_STATE: state,
                JOB_TITLE: 'Software Engineer', JOB_TITLE_LOWER: 'software engineer',
                [config.date]: new Date(i < 20 ? '2025-06-01' : '2024-06-01'), RECEIVED_DATE: new Date('2024-01-01'),
                CASE_STATUS: i % 2 ? 'Certified-Withdrawn' : 'Certified',
                WAGE_RATE_OF_PAY_FROM: i % 2 ? 70 : 120000, WAGE_RATE_OF_PAY_TO: i % 2 ? 90 : 150000, WAGE_UNIT_OF_PAY: i % 2 ? 'Hour' : 'Year',
                JOB_OPP_WAGE_FROM: 100000, JOB_OPP_WAGE_TO: 120000, JOB_OPP_WAGE_PER: 'Year', PWD_WAGE_RATE: 60, PWD_UNIT_OF_PAY: 'Hour',
                _DOL_SOURCE: { url: 'https://www.dol.gov/sites/dolgov/files/example.xlsx', filename: 'example.xlsx', fiscalYear: 2025 },
            }, program);
        });
        rows.push({ CASE_NUMBER: `${program}-missing-location`, [config.company]: 'other employer', [config.employer]: 'Other Employer', [config.state]: 'CA', [config.city]: 'california city' });
        await Model.collection.insertMany(rows);
        const processed = await normalizeWorksites(Model, program);
        assert.equal(processed, 1);
        assert.equal(await normalizeWorksites(Model, program), 0, 'normalization is resumable and idempotent');
    }
    await t.test('worksite and employer location are independent, overlapping branches are deduplicated', async () => {
        for (const [program, Model] of Object.entries(models)) {
            for (const input of [{ worksite: 'ca' }, { worksite: 'ca', location: 'TX' }, { worksite: 'ca', location: 'CA' },
                { worksite: 'san', company: 'Synthropic' }, { worksite: 'CA', employer: 'synthropic, inc.', jobTitle: 'software' },
                { worksite: 'CA', page: '2', limit: '12' }, { worksite: 'CA', receivedYear: '2024' }]) {
                invalidateCounts(); const spec = buildSearch(program, input);
                const expected = await Model.collection.find(spec.query).sort(spec.sort).skip(spec.skip).limit(spec.limit + 1).toArray();
                const result = await searchCases(Model, program, { ...input, count: 'deferred' });
                assert.deepEqual(result.cases.map(row => String(row._id)), expected.slice(0, spec.limit).map(row => String(row._id)));
                assert.equal(result.hasNextPage, expected.length > spec.limit);
                const total = (await countCases(Model, program, input)).totalCount;
                assert.equal(total, await Model.collection.countDocuments(spec.query));
                const insights = await computeInsights(Model, program, input);
                assert.equal(insights.totalCount, total, 'worksite insights must not double count a matching city and state');
            }
            assert.equal((await countCases(Model, program, { worksite: 'CA' })).totalCount, 32, 'an employer address cannot fill a missing worksite');
        }
    });
    await t.test('normal worksite pages select covered IDs and fetch only displayed disclosures', async () => {
        await connection.db.command({ profile: 2 });
        try {
            for (const [program, Model] of Object.entries(models)) {
                invalidateCounts();
                await searchCases(Model, program, { worksite: 'CA', company: 'Synthropic', count: 'deferred', limit: '12' });
                await countCases(Model, program, { worksite: 'CA', company: 'Synthropic' });
            }
        } finally { await connection.db.command({ profile: 0 }); }
        const reads = await connection.db.collection('system.profile').find({ ns: { $in: Object.values(programs).map(config => connection.name + '.' + config.collection) },
            $or: [{ 'command.find': { $exists: true } }, { 'command.aggregate': { $exists: true } }] }).toArray();
        assert(reads.length > 3);
        for (const read of reads) assert(read.docsExamined <= 12, 'worksite selection/count must read covered metadata, not full matching disclosures');
    });
    await t.test('directory groups capitalization only, with separate punctuation variants and indexed suggestions', async () => {
        await refreshDirectory(connection.db, models);
        const matches = await suggestions(connection.db, 'Synthropic INC');
        assert.equal(matches.length, 2); assert.notEqual(matches[0].id, matches[1].id);
        assert.equal(matches.find(row => row.name === 'Synthropic, Inc.').programs.h1b.count, 30);
        assert.equal(matches.find(row => row.name === 'Synthropic INC').programs.h1b.count, 2);
        const plan = await connection.db.collection('employers').find({ searchKey: /^synthropic/ }).sort({ searchKey: 1, _id: 1 }).limit(8).explain('executionStats');
        assert(plan.executionStats.totalKeysExamined <= 8);
        await assert.rejects(suggestions(connection.db, { $ne: '' }), error => error.status === 400);
    });
    await t.test('complete profiles separate programs, wage periods, date years and source provenance', async () => {
        const employer = await connection.db.collection('employers').findOne({ key: 'synthropic, inc.' });
        await computeProfile(connection.db, models, employer);
        const profile = await getProfile(connection.db, models, employer.slug, { refresh: false });
        assert.equal(profile.ready, true);
        assert.equal(profile.summaries.h1b.totalCount, 30);
        assert.equal(profile.summaries.h1b.recent.length, 5);
        const wages = profile.summaries.h1b.wages;
        assert.equal(wages.find(row => row._id === 'HOUR').minimum, 70);
        assert.equal(wages.find(row => row._id === 'HOUR').maximum, 90);
        assert.equal(wages.find(row => row._id === 'YEAR').minimum, 120000);
        assert.equal(profile.summaries.pwd.wages[0].maximum, 60);
        assert.deepEqual(profile.summaries.h1b.timeline, [{ _id: 2024, count: 10 }, { _id: 2025, count: 20 }]);
        assert.equal(profile.summaries.h1b.sources[0].filename, 'example.xlsx');
        assert.equal(await getProfile(connection.db, models, 'invalid', { refresh: false }), null);
        const before = (await suggestions(connection.db, 'Synthropic')).map(row => row.id).sort();
        await refreshDirectory(connection.db, models);
        assert.deepEqual((await suggestions(connection.db, 'Synthropic')).map(row => row.id).sort(), before, 'refresh must preserve profile URLs');
    });
    await t.test('public API, canonical redirects and real missing-page status work together', async () => {
        const app = express(), routes = createEmployerRoutes({ db: () => connection.db, models, render: (url, profile) => `<html><title>${profile?.name || url}</title></html>` });
        app.use('/api/employers', routes.api); app.use('/employers', routes.pages);
        const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
        try {
            const base = `http://127.0.0.1:${server.address().port}`;
            const slug = slugFor('synthropic, inc.');
            const response = await fetch(base + '/api/employers/' + slug); assert.equal(response.status, 200); assert.equal((await response.json()).ready, true);
            const page = await fetch(base + '/employers/' + slug); assert.equal(page.status, 200); assert.match(await page.text(), /Synthropic/);
            assert.equal(page.headers.get('x-robots-tag'), 'index, follow');
            const alias = await fetch(base + '/employers/another-name--' + slug.slice(-24), { redirect: 'manual' }); assert.equal(alias.status, 301); assert.equal(alias.headers.get('location'), '/employers/' + slug);
            assert.equal((await fetch(base + '/employers/missing--' + '0'.repeat(24))).status, 404);
            assert.equal((await fetch(base + '/api/employers?q=a&q=b')).status, 400);
        } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    });
});
