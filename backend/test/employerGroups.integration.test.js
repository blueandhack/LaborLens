const { test } = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const express = require('express');
const { randomUUID } = require('node:crypto');
const { programs, searchIndexes } = require('../services/searchConfig');
const { groups, groupForKey, groupForQuery, cacheIdFor } = require('../services/employerGroups');
const { refreshDirectory, computeProfile, getProfile, suggestions, slugFor, idFor, listEmployers } = require('../services/employers');
const { searchCases, countCases, invalidateCounts } = require('../services/caseSearch');
const { computeInsights } = require('../services/searchInsights');
const { createEmployerRoutes } = require('../routes/employers');
const { addWorksite } = require('../services/worksites');

test('reviewed Infosys names combine actual cases while preserving exact names and distinct companies', { skip: !process.env.MONGO_TEST_URI }, async t => {
    const connection = await mongoose.createConnection(process.env.MONGO_TEST_URI, { dbName: 'identity_' + randomUUID().replaceAll('-', ''), autoIndex: false }).asPromise();
    t.after(async () => { invalidateCounts(); await connection.dropDatabase(); await connection.close(); });
    const group = groups[0], models = {};
    for (const [program, config] of Object.entries(programs)) {
        const Model = connection.model(program, new mongoose.Schema({}, { strict: false }), config.collection); models[program] = Model;
        await Model.collection.createIndex({ CASE_NUMBER: 1 }, { unique: true });
        for (const index of searchIndexes(program)) await Model.collection.createIndex(index.key, { name: index.name, ...(index.partialFilterExpression ? { partialFilterExpression: index.partialFilterExpression } : {}) });
        const keys = [...group.keys, 'infosys public services, inc.', 'infosys bpm limited', 'unrelated employer'];
        await Model.collection.insertMany(keys.flatMap((key, i) => Array.from({ length: i + 2 }, (_, j) => addWorksite({
            CASE_NUMBER: `${program}-${i}-${j}`, [config.company]: key, [config.employer]: key.toUpperCase(),
            [config.city]: 'richardson', [config.state]: 'TX', EMPLOYER_CITY: 'Richardson', EMP_CITY: 'Richardson',
            WORKSITE_CITY: 'San Jose', WORKSITE_STATE: 'CA', PRIMARY_WORKSITE_CITY: 'San Jose', PRIMARY_WORKSITE_STATE: 'CA',
            JOB_TITLE: 'Engineer', JOB_TITLE_LOWER: 'engineer', [config.date]: new Date(2025, 0, j + 1), RECEIVED_DATE: new Date('2024-01-01'),
            CASE_STATUS: 'Certified', ORIGINAL_CERT_DATE: null, WAGE_RATE_OF_PAY_FROM: 120000, WAGE_UNIT_OF_PAY: 'Year',
            JOB_OPP_WAGE_FROM: 110000, JOB_OPP_WAGE_PER: 'Year', PWD_WAGE_RATE: 100000, PWD_UNIT_OF_PAY: 'Year',
            _DOL_SOURCE: { url: 'https://www.dol.gov/sites/dolgov/files/example.xlsx', filename: 'example.xlsx', fiscalYear: 2025 },
            _DOL_ALTERNATE_RECORDS: [{ note: 'x'.repeat(2048) }],
        }, program))));
    }
    await refreshDirectory(connection.db, models);
    const primary = await connection.db.collection('employers').findOne({ _id: group.id });
    const expectedCount = 2 + 3 + 4 + 5 + 6;
    await t.test('old exact-name caches cannot become a combined profile', async () => {
        await connection.db.collection('employer_profiles').insertOne({ _id: group.id, version: 1, summaries: { h1b: { totalCount: 999 } }, updatedAt: new Date() });
        const profile = await getProfile(connection.db, models, slugFor(group.key), { refresh: false });
        assert.equal(profile.ready, false); assert.deepEqual(profile.summaries, {});
        assert.equal(profile.programs.perm.count, expectedCount); assert.equal(profile.reportedNames.length, 5);
        assert.notEqual(cacheIdFor(primary), primary._id);
    });
    await t.test('profiles combine reviewed names once and preserve per-name evidence', async () => {
        const snapshot = await computeProfile(connection.db, models, primary);
        assert.equal(snapshot._id, cacheIdFor(primary));
        const profile = await getProfile(connection.db, models, slugFor('infosys ltd.'), { refresh: false });
        assert.equal(profile.ready, true); assert.equal(profile.slug, slugFor(group.key));
        assert.equal(profile.name, group.name);
        for (const program of Object.keys(programs)) assert.equal(profile.summaries[program].totalCount, expectedCount);
        assert.equal(profile.reportedNames.find(row => row.key === 'infosys ltd.').programs.perm.count, 4);
        assert(profile.grouping.evidence.some(item => item.url.startsWith('https://www.infosys.com/')));
        assert.equal((await connection.db.collection('employer_profiles').findOne({ _id: group.id })).summaries.h1b.totalCount, 999, 'scoped caches must leave the old exact-name cache untouched');
    });
    await t.test('group search, typed known names, counts, insights and all sort modes match the same case set', async () => {
        for (const [program, Model] of Object.entries(models)) {
            for (const input of [{ employerGroup: group.id }, { company: 'Infosys Limited' }, { company: 'Infosys Technologies Ltd.' },
                { employerGroup: group.id, worksite: 'CA', location: 'TX' }]) {
                invalidateCounts();
                for (const sort of ['event_desc', 'event_asc', 'received_asc', ...(program === 'h1b' ? ['certification_desc', 'certification_asc'] : [])]) {
                    const first = await searchCases(Model, program, { ...input, sort, count: 'deferred', limit: '12' });
                    const second = await searchCases(Model, program, { ...input, sort, count: 'deferred', limit: '12', page: '2' });
                    const rows = [...first.cases, ...second.cases];
                    assert.equal(rows.length, expectedCount);
                    assert.equal(new Set(rows.map(row => String(row._id))).size, expectedCount);
                    assert(rows.every(row => group.keys.includes(row[programs[program].employer].toLowerCase())));
                    assert(rows.every(row => row.EMPLOYER_PROFILE_SLUG === slugFor(group.key)));
                    assert.equal(first.employerGroup.id, group.id);
                }
                assert.equal((await countCases(Model, program, input)).totalCount, expectedCount);
                assert.equal((await computeInsights(Model, program, input)).totalCount, expectedCount);
            }
            const exact = await searchCases(Model, program, { employer: 'infosys ltd.', count: 'deferred' });
            assert.equal(exact.cases.length, 4); assert.equal(exact.employerGroup, undefined);
            const subsidiary = await searchCases(Model, program, { company: 'Infosys Public Services', count: 'deferred' });
            assert.equal(subsidiary.cases.length, 7); assert.equal(subsidiary.employerGroup, undefined);
            await assert.rejects(searchCases(Model, program, { employerGroup: 'unknown' }), error => error.status === 400);
            await assert.rejects(searchCases(Model, program, { employerGroup: group.id, employer: group.key }), error => error.status === 400);
        }
    });
    await t.test('suggestions deduplicate reviewed groups and directory searches expose source-name counts', async () => {
        for (const query of ['Infosys', 'Infosys Limited', 'Infosys Technologies Ltd.']) {
            const rows = await suggestions(connection.db, query);
            const matches = rows.filter(row => row.groupId === group.id);
            assert.equal(matches.length, 1); assert.equal(matches[0].programs.perm.count, expectedCount);
        }
        const directory = await listEmployers(connection.db, { q: 'Infosys Limited', sort: 'perm_desc' });
        assert.equal(directory.employers.length, 5);
        assert.equal(directory.employerGroup.id, group.id);
        assert.equal(directory.employers.reduce((sum, row) => sum + row.programs.perm.count, 0), expectedCount);
        assert(directory.employers.every(row => row.slug === slugFor(group.key)));
    });
    await t.test('old alias URLs redirect to the canonical combined profile and grouped sitemap dates resolve', async () => {
        await connection.db.collection('employers').updateOne({ _id: group.id }, { $set: { featured: true, featuredRank: 0 } });
        const app = express(), routes = createEmployerRoutes({ db: () => connection.db, models, render: (_url, profile) => `<h1>${profile?.name}</h1>` });
        app.use('/api/employers', routes.api); app.use('/employers', routes.pages);
        const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
        try {
            const base = 'http://127.0.0.1:' + server.address().port;
            const legacy = await fetch(base + '/employers/' + slugFor('infosys ltd.'), { redirect: 'manual' });
            assert.equal(legacy.status, 301); assert.equal(legacy.headers.get('location'), '/employers/' + slugFor(group.key));
            const sitemap = await (await fetch(base + '/employers/sitemap.xml')).text();
            assert(sitemap.includes(slugFor(group.key))); assert.equal((sitemap.match(/<url>/g) || []).length, 1);
        } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    });
});
