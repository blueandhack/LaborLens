const { test } = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const express = require('express');
const { randomUUID } = require('node:crypto');
const { programs, searchIndexes } = require('../services/searchConfig');
const { refreshMap, getMap, getMapOptions, getLocalMap, employerPlaces, invalidateMap } = require('../services/map');
const { searchCases, countCases, invalidateCounts } = require('../services/caseSearch');
const { computeInsights } = require('../services/searchInsights');
const { createMapRoutes } = require('../routes/map');
const { addWorksite } = require('../services/worksites');

// Field names per program for the location, occupation, level and wage of a case.
const layout = {
    h1b: { zip: 'WORKSITE_POSTAL_CODE', city: 'WORKSITE_CITY', state: 'WORKSITE_STATE', soc: 'PWD_SOC_CODE', level: 'PW_WAGE_LEVEL', wage: 'WAGE_RATE_OF_PAY_FROM', unit: 'WAGE_UNIT_OF_PAY' },
    perm: { zip: 'WORKSITE_POSTAL_CODE', city: 'WORKSITE_CITY', state: 'WORKSITE_STATE', soc: 'PWD_SOC_CODE', level: 'PWD_OES_WAGE_LEVEL', wage: 'JOB_OPP_WAGE_FROM', unit: 'JOB_OPP_WAGE_PER' },
    pwd: { zip: 'PRIMARY_WORKSITE_POSTAL_CODE', city: 'PRIMARY_WORKSITE_CITY', state: 'PRIMARY_WORKSITE_STATE', soc: 'PWD_SOC_CODE', level: 'PWD_OES_WAGE_LEVEL', wage: 'PWD_WAGE_RATE', unit: 'PWD_UNIT_OF_PAY' },
};
let serial = 0;
function record(program, { employer = 'acme corp', zip, city, state, year = 2024, soc = '15-1252.00', level = 'II', wage = 120000, unit = 'Year' }) {
    const config = programs[program], fields = layout[program];
    return addWorksite({ CASE_NUMBER: `${program}-${serial++}`, [config.company]: employer, [config.employer]: employer.toUpperCase(),
        [config.date]: new Date(Date.UTC(year, 5, 1)), JOB_TITLE: 'Engineer', JOB_TITLE_LOWER: 'engineer', CASE_STATUS: 'Certified',
        [fields.zip]: zip, [fields.city]: city, [fields.state]: state, [fields.soc]: soc, [fields.level]: level, [fields.wage]: wage, [fields.unit]: unit,
        _DISCOVERY_VERSION: 1 }, program);
}
const times = (count, make) => Array.from({ length: count }, (_, i) => make(i));

test('map summarizes filings by worksite state and metro, occupation and year', { skip: !process.env.MONGO_TEST_URI }, async t => {
    const connection = await mongoose.createConnection(process.env.MONGO_TEST_URI, { dbName: 'map_' + randomUUID().replaceAll('-', ''), autoIndex: false }).asPromise();
    t.after(async () => { invalidateCounts(); invalidateMap(); await connection.dropDatabase(); await connection.close(); });
    const db = connection.db, models = {};
    for (const [program, config] of Object.entries(programs)) {
        const Model = connection.model(program, new mongoose.Schema({}, { strict: false }), config.collection); models[program] = Model;
        await Model.collection.createIndex({ CASE_NUMBER: 1 }, { unique: true });
        for (const index of searchIndexes(program)) await Model.collection.createIndex(index.key, { name: index.name, ...(index.partialFilterExpression ? { partialFilterExpression: index.partialFilterExpression } : {}) });
    }
    await db.collection('discovery_state').insertOne({ _id: 'worksites', programs: { h1b: { ready: true }, perm: { ready: true }, pwd: { ready: true } } });
    await models.h1b.collection.insertMany([
        // Seattle area: 10 software developers (2010 and 2018 codes), half Level III/IV, $100k–$190k a year.
        ...times(10, i => record('h1b', { zip: i % 2 ? '98052-6399' : '98101', city: i % 2 ? 'Redmond' : 'Seattle', state: i % 3 ? 'WA' : 'Washington',
            soc: i % 2 ? '15-1132' : '15-1252.00', level: i < 5 ? 'Level II' : i % 2 ? 'III' : 'IV', wage: 100000 + i * 10000, year: i < 6 ? 2024 : 2025 })),
        // Seattle without a ZIP: placed through the learned city.
        record('h1b', { city: 'SEATTLE', state: 'WA', wage: 50, unit: 'Hour', year: 2025 }),
        // An unknown city without a ZIP counts in its state only.
        record('h1b', { city: 'Nowhere', state: 'WA', year: 2025 }),
        // Austin accountants, hourly wages.
        ...times(3, () => record('h1b', { employer: 'other llc', zip: '78701', city: 'Austin', state: 'tx', soc: '13-2011.00', level: 'I', wage: 40, unit: 'Hour' })),
        // No location at all.
        record('h1b', { soc: 'garbage', wage: null }),
    ]);
    await models.perm.collection.insertMany(times(4, () => record('perm', { zip: '10001', city: 'New York', state: 'NY', level: 'Level IV', wage: 150000 })));
    await models.pwd.collection.insertMany(times(2, () => record('pwd', { zip: '06103', city: 'Hartford', state: 'CT', wage: 90000 })));

    const progress = [];
    await refreshMap(db, models, { onProgress: event => progress.push(event) });
    assert.deepEqual(progress.filter(event => event.event === 'map-ready').map(event => event.program), ['h1b', 'perm', 'pwd']);
    assert.deepEqual(await db.listCollections({ name: /_tmp$/ }).toArray(), [], 'temporary cells are dropped');

    await t.test('all filings: states, metros, medians, wage-level shares and coverage', async () => {
        const map = await getMap(db, { program: 'h1b' });
        assert.equal(map.total, 16); assert.equal(map.located, 15);
        const wa = map.states.find(row => row.code === 'WA');
        assert.equal(wa.count, 12); assert.equal(wa.name, 'Washington');
        assert.ok(wa.perCapita > 0);
        const seattle = map.metros.find(row => row.code === '42660');
        assert.equal(seattle.count, 11, 'ten ZIP cases plus the learned city');
        assert.equal(seattle.name, 'Seattle-Tacoma-Bellevue, WA'); assert.ok(seattle.x > 0 && seattle.y > 0);
        // 11 annual wages: $100k…$190k and $104k (50 × 2,080); the median is near $140k.
        assert.ok(seattle.median > 130000 && seattle.median < 150000, String(seattle.median));
        assert.equal(seattle.senior, 0.455, '5 of 11 cases with a level are Level III or IV');
        const texas = map.states.find(row => row.code === 'TX');
        assert.equal(texas.count, 3); assert.equal(texas.median, null, 'too few wages for a median');
        assert.equal(map.metros.find(row => row.code === '12420').count, 3);
    });
    await t.test('occupation and year slices, with old SOC codes combined', async () => {
        const options = await getMapOptions(db, { program: 'h1b' });
        assert.equal(options.ready, true);
        assert.deepEqual(options.years.map(row => row.year), [2025, 2024]);
        assert.equal(options.occupations.length, 0, 'occupations need 50 filings to be listed');
        const all2025 = await getMap(db, { program: 'h1b', year: '2025' });
        assert.equal(all2025.total, 6);
        assert.equal(all2025.metros.find(row => row.code === '42660').count, 5);
        const empty = await getMap(db, { program: 'h1b', occupation: '15-1252' });
        assert.equal(empty.total, 0); assert.equal(empty.occupationTitle, 'Software Developers');
        await assert.rejects(getMap(db, { program: 'h1b', year: 'x' }), /Invalid year/);
    });
    await t.test('county and city detail within a state', async () => {
        const wa = await getLocalMap(db, { program: 'h1b', state: 'wa' });
        assert.equal(wa.ready, true); assert.equal(wa.state, 'WA'); assert.equal(wa.total, 12);
        // Seattle (98101) is in King County, as is Redmond (98052); ZIP-less Seattle joins through its learned county.
        assert.deepEqual(wa.counties.map(row => [row.fips, row.name, row.count]), [['53033', 'King County', 11]]);
        assert.ok(wa.counties[0].perCapita > 0 && wa.counties[0].x > 0);
        const seattle = wa.cities.find(row => row.key === 'seattle');
        assert.equal(seattle.name, 'Seattle'); assert.equal(seattle.county, '53033'); assert.equal(seattle.count, 6);
        assert.ok(seattle.x > 0 && seattle.y > 0);
        assert.deepEqual(seattle.zips.map(row => [row.zip, row.count]), [], 'ZIPs are listed for cities with at least 10 filings');
        const nowhere = wa.cities.find(row => row.key === 'nowhere');
        assert.deepEqual([nowhere.name, nowhere.county, nowhere.x, nowhere.count], ['Nowhere', null, null, 1], 'a city without a ZIP has no map point');
        assert.equal((await getLocalMap(db, { program: 'h1b', state: 'WA', year: '2024' })).total, 6);
        const texas = await getLocalMap(db, { program: 'h1b', state: 'TX' });
        assert.deepEqual(texas.cities.map(row => [row.name, row.county]), [['Austin', '48453']]);
        assert.equal((await getLocalMap(db, { program: 'h1b', state: 'CA' })).total, 0);
        const hartford = await getLocalMap(db, { program: 'pwd', state: 'CT' });
        assert.equal(hartford.counties[0].name, 'Capitol Planning Region', 'Connecticut uses its 2022 planning regions');
        await assert.rejects(getLocalMap(db, { program: 'h1b', state: 'Ontario' }), /Invalid state/);
        await assert.rejects(getLocalMap(db, { program: 'h1b' }), /Invalid state/);
    });
    await t.test('other programs and unchanged data', async () => {
        const perm = await getMap(db, { program: 'perm' });
        assert.equal(perm.metros[0].code, '35620'); assert.equal(perm.states[0].senior, null);
        const pwd = await getMap(db, { program: 'pwd' });
        assert.equal(pwd.metros[0].code, '25540', 'Connecticut ZIPs use 2023 planning-region metros');
        progress.length = 0;
        await refreshMap(db, models, { onProgress: event => progress.push(event) });
        assert.equal(progress.filter(event => event.event === 'map-unchanged').length, 3);
    });
    await t.test('occupations with enough filings get their own slices', async () => {
        await models.perm.collection.insertMany(times(50, i => record('perm', { zip: i % 2 ? '94043' : '98052', city: 'x', state: i % 2 ? 'CA' : 'WA', soc: '15-1133.00', year: 2023 })));
        await refreshMap(db, models, { only: ['perm'] });
        const options = await getMapOptions(db, { program: 'perm' });
        assert.deepEqual(options.occupations, [{ code: '15-1252', title: 'Software Developers', count: 54 }]);
        const developers = await getMap(db, { program: 'perm', occupation: '15-1252', year: '2023' });
        assert.equal(developers.total, 50);
        assert.deepEqual(developers.metros.map(row => [row.code, row.count]).sort(), [['41940', 25], ['42660', 25]]);
        assert.equal((await getMap(db, { program: 'perm', occupation: '15-1252', year: '2024' })).total, 4);
        const california = await getLocalMap(db, { program: 'perm', occupation: '15-1252', year: '2023', state: 'CA' });
        assert.deepEqual(california.counties.map(row => [row.name, row.count]), [['Santa Clara County', 25]]);
        assert.equal((await getLocalMap(db, { program: 'perm', occupation: '15-1252', state: 'NY' })).total, 4);
    });
    await t.test('employer worksite places', async () => {
        const places = await employerPlaces(db, models.h1b, 'h1b', ['acme corp']);
        assert.equal(places.total, 13); assert.equal(places.located, 12);
        assert.equal(places.metros[0].code, '42660'); assert.equal(places.metros[0].count, 11);
        assert.ok(places.metros[0].median > 0);
        assert.deepEqual(places.states.map(row => [row.code, row.count]), [['WA', 12]]);
    });
    await t.test('worksite state search matches postal codes and names; the city then matches cities only', async () => {
        const wa = await searchCases(models.h1b, 'h1b', { worksiteState: 'wa' });
        assert.equal(wa.totalCount, 12);
        assert.equal((await countCases(models.h1b, 'h1b', { worksiteState: 'WA' })).totalCount, 12);
        const seattle = await searchCases(models.h1b, 'h1b', { worksiteState: 'WA', worksite: 'seattle', count: 'deferred' });
        assert.equal(seattle.cases.length, 6);
        // "Washington" as worksite text alone also matches the state name; with a state it is a city.
        assert.equal((await countCases(models.h1b, 'h1b', { worksiteState: 'WA', worksite: 'washington' })).totalCount, 0);
        assert.equal((await countCases(models.h1b, 'h1b', { worksiteState: 'WA', company: 'acme', decisionYear: '2025' })).totalCount, 6);
        assert.equal((await searchCases(models.h1b, 'h1b', { worksiteState: 'WA', sort: 'certification_desc' })).cases.length, 12);
        await assert.rejects(searchCases(models.h1b, 'h1b', { worksiteState: 'Ontario' }), /Invalid worksiteState/);
        const insights = await computeInsights(models.h1b, 'h1b', { worksiteState: 'WA' });
        assert.equal(insights.totalCount, 12);
    });
    await t.test('HTTP routes', async () => {
        const app = express(); app.use('/api/map', createMapRoutes({ db: () => db }));
        const server = app.listen(0); t.after(() => server.close());
        const base = `http://127.0.0.1:${server.address().port}/api/map`;
        const map = await fetch(base + '?program=pwd').then(response => response.json());
        assert.equal(map.total, 2);
        assert.equal((await fetch(base + '/options?program=h1b').then(response => response.json())).years.length, 2);
        const local = await fetch(base + '/local?program=h1b&state=WA').then(response => response.json());
        assert.equal(local.counties[0].name, 'King County');
        assert.equal((await fetch(base + '/local?program=h1b&state=ZZ')).status, 400);
        const invalid = await fetch(base + '?program=nope');
        assert.equal(invalid.status, 400); assert.match((await invalid.json()).error, /Invalid program/);
    });
});
