const { test } = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const express = require('express');
const { randomUUID } = require('node:crypto');
const { programs, searchIndexes } = require('../services/searchConfig');
const { groups } = require('../services/employerGroups');
const { refreshIdentities, findIdentity } = require('../services/employerIdentity');
const { refreshDirectory, computeProfile, getProfile, suggestions, slugFor, idFor, listEmployers, cacheIdFor, refreshFeatured } = require('../services/employers');
const { searchCases, countCases, invalidateCounts } = require('../services/caseSearch');
const { computeInsights } = require('../services/searchInsights');
const { createEmployerRoutes } = require('../routes/employers');
const { addWorksite } = require('../services/worksites');

const fein = { perm: 'EMP_FEIN', pwd: 'EMPLOYER_FEIN' };
const zip = { perm: 'EMP_POSTCODE', pwd: 'EMPLOYER_POSTAL_CODE', h1b: 'EMPLOYER_POSTAL_CODE' };
function record(program, key, i, extra = {}) {
    const config = programs[program];
    return addWorksite({
        CASE_NUMBER: `${program}-${key}-${i}`, [config.company]: key, [config.employer]: key.toUpperCase(),
        [config.city]: 'richardson', [config.state]: 'TX', EMPLOYER_CITY: 'Richardson', EMP_CITY: 'Richardson',
        WORKSITE_CITY: 'San Jose', WORKSITE_STATE: 'CA', PRIMARY_WORKSITE_CITY: 'San Jose', PRIMARY_WORKSITE_STATE: 'CA',
        JOB_TITLE: 'Engineer', JOB_TITLE_LOWER: 'engineer', [config.date]: new Date(2025, 0, i + 1), RECEIVED_DATE: new Date('2024-01-01'),
        CASE_STATUS: 'Certified', ORIGINAL_CERT_DATE: null, WAGE_RATE_OF_PAY_FROM: 120000, WAGE_UNIT_OF_PAY: 'Year',
        JOB_OPP_WAGE_FROM: 110000, JOB_OPP_WAGE_PER: 'Year', PWD_WAGE_RATE: 100000, PWD_UNIT_OF_PAY: 'Year',
        _DOL_SOURCE: { url: 'https://www.dol.gov/sites/dolgov/files/example.xlsx', filename: 'example.xlsx', fiscalYear: 2025 },
        ...extra,
    }, program);
}

test('employer identities combine spelling variants, FEIN-linked renames and reviewed names, and nothing else', { skip: !process.env.MONGO_TEST_URI }, async t => {
    const connection = await mongoose.createConnection(process.env.MONGO_TEST_URI, { dbName: 'identity_' + randomUUID().replaceAll('-', ''), autoIndex: false }).asPromise();
    t.after(async () => { invalidateCounts(); await connection.dropDatabase(); await connection.close(); });
    const group = groups[0], models = {};
    const infosysKeys = [...group.keys, 'infosys public services, inc.', 'infosys bpm limited', 'unrelated employer'];
    // Cognizant-style: H-1B uses "US CORP" and "U.S. CORPORATION"; PERM uses "US CORPORATION".
    const cognizant = { h1b: { 'cognizant technology solutions us corp': 9, 'cognizant technology solutions u.s. corporation': 4 },
        perm: { 'cognizant technology solutions us corporation': 6 }, pwd: { 'cognizant technology solutions us corporation ': 2 } };
    for (const [program, config] of Object.entries(programs)) {
        const Model = connection.model(program, new mongoose.Schema({}, { strict: false }), config.collection); models[program] = Model;
        await Model.collection.createIndex({ CASE_NUMBER: 1 }, { unique: true });
        for (const index of searchIndexes(program)) await Model.collection.createIndex(index.key, { name: index.name, ...(index.partialFilterExpression ? { partialFilterExpression: index.partialFilterExpression } : {}) });
        const rows = infosysKeys.flatMap((key, i) => Array.from({ length: i + 2 }, (_, j) => record(program, key, j, { _DOL_ALTERNATE_RECORDS: [{ note: 'x'.repeat(2048) }] })));
        for (const [key, count] of Object.entries(cognizant[program] || {})) rows.push(...Array.from({ length: count }, (_, j) => record(program, key, j)));
        // Facebook → Meta: same FEIN and ZIP on PERM/PWD. A typo of that FEIN elsewhere has another ZIP and is ignored.
        rows.push(...Array.from({ length: 5 }, (_, j) => record(program, 'facebook, inc.', j, program === 'h1b' ? {} : { [fein[program]]: j ? undefined : '20-1665019', [zip[program]]: '94025-1452' })));
        rows.push(...Array.from({ length: 3 }, (_, j) => record(program, 'meta platforms, inc.', j, { [programs[program].date]: new Date(2026, 0, j + 1),
            ...(program === 'h1b' ? {} : { [fein[program]]: '201665019', [zip[program]]: '94025' }) })));
        rows.push(record(program, 'tiny typo employer llc', 0, program === 'h1b' ? {} : { [fein[program]]: '20-1665019', [zip[program]]: '10001' }));
        // The legal form must agree: an LLC does not merge with an Inc.
        rows.push(record(program, 'acme widgets llc', 0), record(program, 'acme widgets, inc.', 0));
        // A FEIN shared by many names is an umbrella (e.g. a university system), never a link.
        if (program !== 'h1b') rows.push(...Array.from({ length: 7 }, (_, j) => record(program, `state university campus ${j}`, 0, { [fein[program]]: '11-1111112', [zip[program]]: '12345' })));
        // Salesforce-style rename before FEINs were disclosed: only USCIS petition data links the names.
        rows.push(...Array.from({ length: 4 }, (_, j) => record(program, 'salesforce.com, inc.', j, { [programs[program].date]: new Date(2021, 0, j + 1) })));
        rows.push(...Array.from({ length: 3 }, (_, j) => record(program, 'salesforce, inc.', j)));
        rows.push(record(program, 'salesforce.org', 0, { [programs[program].date]: new Date(2019, 0, 1) }));
        await Model.collection.insertMany(rows);
    }
    const uscis = (employer, nameKey, fiscalYear, taxId) => ({ fiscalYear, employer, nameKey, taxId, zip: '94105', initialApprovals: 10, initialDenials: 0, continuingApprovals: 20, continuingDenials: 1 });
    await connection.db.collection('uscis_h1b').insertMany([
        ...[2019, 2020, 2021, 2022].map(year => uscis('SALESFORCE.COM INC', 'salesforce com inc', year, '0693')),
        ...[2022, 2023, 2024, 2025].map(year => uscis('SALESFORCE INC', 'salesforce inc', year, '0693')),
        uscis('SALESFORCE.ORG', 'salesforce org', 2019, '9769'), uscis('SALESFORCE.COM INC', 'salesforce com inc', 2020, '0269'),
    ]);
    await refreshDirectory(connection.db, models);
    const result = await refreshIdentities(connection.db, models);
    assert(result.feinLinks >= 1); assert.equal(result.taxIdLinks, 1);
    const identity = await findIdentity(connection.db, group.id);
    const expectedCount = 2 + 3 + 4 + 5 + 6;

    await t.test('spelling variants form one employer whose PERM filings are no longer zero', async () => {
        const combined = await findIdentity(connection.db, idFor('cognizant technology solutions us corporation'));
        assert.equal(combined._id, idFor('cognizant technology solutions us corp'), 'the largest filing name is canonical');
        assert.equal(combined.slug, slugFor('cognizant technology solutions us corp'));
        assert.equal(combined.keys.length, 4);
        assert.deepEqual([combined.programs.h1b.count, combined.programs.perm.count, combined.programs.pwd.count], [13, 6, 2]);
        const directory = await listEmployers(connection.db, { q: 'Cognizant', sort: 'perm_desc' });
        assert.equal(directory.employers.length, 1);
        assert.equal(directory.employers[0].programs.perm.count, 6); assert.equal(directory.employers[0].names, 4);
        const byPunctuation = await listEmployers(connection.db, { q: 'Cognizant Technology Solutions U.S. Corp' });
        assert.equal(byPunctuation.employers[0].id, combined._id);
        const perm = await searchCases(models.perm, 'perm', { employerGroup: combined._id, count: 'deferred' });
        assert.equal(perm.cases.length, 6); assert.equal(perm.employerGroup.names, 4);
        assert(perm.cases.every(row => row.EMPLOYER_PROFILE_SLUG === combined.slug));
        const h1b = await searchCases(models.h1b, 'h1b', { employerGroup: idFor('cognizant technology solutions u.s. corporation'), count: 'deferred' });
        assert.equal(h1b.cases.length, 13, 'a member ID resolves to its identity');
        assert.equal((await connection.db.collection('employer_identities').find({ keys: 'acme widgets llc' }).next()).keys.length, 1);
    });
    await t.test('a FEIN-linked rename combines while typos and umbrella FEINs stay separate', async () => {
        const meta = await findIdentity(connection.db, idFor('meta platforms, inc.'));
        assert.deepEqual([...meta.keys].sort(), ['facebook, inc.', 'meta platforms, inc.']);
        assert.equal(meta._id, idFor('meta platforms, inc.'), 'the most recently used name titles a renamed employer, despite fewer filings');
        assert.equal(meta.name, 'META PLATFORMS, INC.');
        assert.equal(meta.programs.h1b.count, 8, 'H-1B names without a FEIN join through their normalized spelling');
        assert.equal(meta.grouping.kind, 'automatic');
        assert.match(meta.grouping.reason, /FEIN \(ending 5019\)/); assert.match(meta.grouping.reason, /94025/);
        assert(meta.grouping.evidence.every(item => item.url.startsWith('/cases/')));
        assert.equal((await findIdentity(connection.db, idFor('tiny typo employer llc'))).keys.length, 1);
        assert.equal((await findIdentity(connection.db, idFor('state university campus 1'))).keys.length, 1);
    });
    await t.test('a rename that predates FEINs combines through its USCIS tax ID and ZIP code', async () => {
        const salesforce = await findIdentity(connection.db, idFor('salesforce.com, inc.'));
        assert.deepEqual([...salesforce.keys].sort(), ['salesforce, inc.', 'salesforce.com, inc.']);
        assert.equal(salesforce._id, idFor('salesforce, inc.'), 'the current name titles the identity');
        assert.equal(salesforce.grouping.kind, 'automatic');
        assert.match(salesforce.grouping.reason, /tax ID ending 0693 and ZIP code 94105/);
        assert(salesforce.grouping.evidence.some(item => item.url.startsWith('/h1b-approvals?q=')));
        assert.equal((await findIdentity(connection.db, idFor('salesforce.org'))).keys.length, 1, 'another tax ID stays separate');
        assert.equal((await connection.db.collection('discovery_state').findOne({ _id: 'employer_identities' })).taxIdLinks, 1);
    });
    await t.test('old exact-name caches cannot become a combined profile', async () => {
        await connection.db.collection('employer_profiles').insertOne({ _id: group.id, version: 1, summaries: { h1b: { totalCount: 999 } }, updatedAt: new Date() });
        const profile = await getProfile(connection.db, models, slugFor(group.key), { refresh: false });
        assert.equal(profile.ready, false); assert.deepEqual(profile.summaries, {});
        assert.equal(profile.programs.perm.count, expectedCount); assert.equal(profile.reportedNames.length, 5);
        assert.notEqual(cacheIdFor(identity), identity._id);
    });
    await t.test('profiles combine reviewed names once and preserve per-name evidence', async () => {
        const snapshot = await computeProfile(connection.db, models, identity);
        assert.equal(snapshot._id, cacheIdFor(identity));
        const profile = await getProfile(connection.db, models, slugFor('infosys ltd.'), { refresh: false });
        assert.equal(profile.ready, true); assert.equal(profile.slug, slugFor(group.key));
        assert.equal(profile.name, group.name);
        for (const program of Object.keys(programs)) assert.equal(profile.summaries[program].totalCount, expectedCount);
        assert.equal(profile.reportedNames.find(row => row.key === 'infosys ltd.').programs.perm.count, 4);
        assert.equal(profile.grouping.kind, 'reviewed');
        assert(profile.grouping.evidence.some(item => item.url.startsWith('https://www.infosys.com/')));
        assert.match(profile.grouping.policy, /subsidiaries/);
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
    await t.test('suggestions and directory rows count each identity once with combined totals', async () => {
        for (const query of ['Infosys', 'Infosys Limited', 'Infosys Technologies Ltd.']) {
            const rows = await suggestions(connection.db, query);
            const matches = rows.filter(row => row.groupId === group.id);
            assert.equal(matches.length, 1); assert.equal(matches[0].programs.perm.count, expectedCount);
        }
        const directory = await listEmployers(connection.db, { q: 'Infosys', sort: 'perm_desc' });
        assert.deepEqual(directory.employers.map(row => row.name), [group.name, 'INFOSYS BPM LIMITED', 'INFOSYS PUBLIC SERVICES, INC.']);
        assert.equal(directory.employers[0].programs.perm.count, expectedCount);
        const all = await listEmployers(connection.db, { sort: 'perm_desc' });
        assert.equal(new Set(all.employers.map(row => row.id)).size, all.employers.length);
        assert.equal(all.employers[0].id, group.id);
    });
    await t.test('a later identity build is stable and keeps featured profiles and alias redirects', async () => {
        await refreshFeatured(connection.db, models, { maxProfiles: 2 });
        assert((await connection.db.collection('employer_identities').findOne({ _id: group.id })).featured);
        const before = await connection.db.collection('employer_identities').countDocuments();
        await refreshIdentities(connection.db, models);
        assert.equal(await connection.db.collection('employer_identities').countDocuments(), before);
        assert((await connection.db.collection('employer_identities').findOne({ _id: group.id })).featured, 'rebuilds keep featured flags');
        const app = express(), routes = createEmployerRoutes({ db: () => connection.db, models, render: (_url, profile) => `<h1>${profile?.name}</h1>` });
        app.use('/api/employers', routes.api); app.use('/employers', routes.pages);
        const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
        try {
            const base = 'http://127.0.0.1:' + server.address().port;
            const legacy = await fetch(base + '/employers/' + slugFor('infosys ltd.'), { redirect: 'manual' });
            assert.equal(legacy.status, 301); assert.equal(legacy.headers.get('location'), '/employers/' + slugFor(group.key));
            const variant = await fetch(base + '/employers/' + slugFor('cognizant technology solutions us corporation'), { redirect: 'manual' });
            assert.equal(variant.headers.get('location'), '/employers/' + slugFor('cognizant technology solutions us corp'));
            const sitemap = await (await fetch(base + '/employers/sitemap.xml')).text();
            assert(sitemap.includes(slugFor(group.key)));
            const featured = await (await fetch(base + '/api/employers')).json();
            assert(featured.employers.some(row => row.groupId === group.id));
        } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    });
});
