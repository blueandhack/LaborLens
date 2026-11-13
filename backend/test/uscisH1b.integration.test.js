const { test } = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const express = require('express');
const { randomUUID } = require('node:crypto');
const { idFor, nameKey, slugFor } = require('../services/employerIdentity');
const uscis = require('../services/uscisH1b');
const { createUscisRoutes } = require('../routes/uscis');

const row = (fiscalYear, employer, [ia, id, ca, cd], { state = 'TX', city = 'AUSTIN', naics = '54' } = {}) => {
    const key = employer ? nameKey(employer) : null;
    return { fiscalYear, employer, nameKey: key, groupKey: key && uscis.expanded(key), searchKey: employer.toLowerCase(), naics, industry: uscis.industryOf(naics),
        taxId: '0001', state, city, zip: '78701', initialApprovals: ia, initialDenials: id, continuingApprovals: ca, continuingDenials: cd };
};
// A LaborLens employer name (from DOL filings), as the directory stores it.
const employer = (key, count, identity) => ({ _id: idFor(key), key, name: key.toUpperCase(), nameKey: nameKey(key), identity: identity || idFor(key),
    identitySlug: slugFor(key), programs: { h1b: { count } } });

test('USCIS petition decisions import, group, link to employers and answer queries', { skip: !process.env.MONGO_TEST_URI }, async t => {
    const connection = await mongoose.createConnection(process.env.MONGO_TEST_URI, { dbName: 'uscis_' + randomUUID().replaceAll('-', '') }).asPromise();
    t.after(async () => { uscis.clearUscisCache(); await connection.dropDatabase(); await connection.close(); });
    const db = connection.db;
    await db.collection('employers').insertMany([
        employer('cognizant technology solutions us corp', 900),
        employer('globex systems inc', 50),
        employer('initech consulting services group llc', 20),
        // Two different employers start with the same cut-off USCIS name: no link.
        employer('massive dynamic research laboratories east inc', 5), employer('massive dynamic research laboratories west inc', 5),
    ]);
    const official = { name: 'h1b_datahubexport.csv', url: 'https://www.uscis.gov/x.csv', official: true, archived: true };
    await uscis.importUscisRows(db, [
        row(2022, 'COGNIZANT TECHNOLOGY SOLUTIONS US CORP', [100, 10, 300, 5]),
        row(2016, 'COGNIZANT TECH SOLNS US CORP', [80, 20, 200, 10], { state: 'NJ', city: 'TEANECK' }),
        row(2016, 'COGNIZANT TECHNOLOGY SOLUTIONS US', [5, 0, 5, 0], { state: 'NJ', city: 'TEANECK' }), // Cut short by the source.
        row(2022, 'Globex Syss Inc', [10, 0, 0, 0], { state: 'CA', city: 'OAKLAND', naics: '32' }),
        row(2022, 'INITECH CONSULTING SERVICES GROUP L', [3, 1, 0, 0]),
        row(2022, 'MASSIVE DYNAMIC RESEARCH LABORATORIE', [1, 30, 0, 0]),
        row(2023, 'COGNIZANT TECHNOLOGY SOLUTIONS US CORP', [7, 1, 9, 0]),
        row(2022, '', [2, 0, 0, 0]),
    ], { source: official });

    const docs = await db.collection(uscis.EMPLOYERS).find().sort({ _id: 1 }).toArray();
    const cognizant = docs.find(doc => doc._id === 'cognizant technology solutions us corp');
    assert.ok(cognizant, 'abbreviated and cut-off spellings join the full name');
    assert.equal(cognizant.approvals, 100 + 300 + 80 + 200 + 5 + 5 + 7 + 9);
    assert.deepEqual(cognizant.years.map(year => year.fiscalYear), [2016, 2022, 2023]);
    assert.equal(cognizant.name, 'COGNIZANT TECHNOLOGY SOLUTIONS US CORP', 'named as in its latest year');
    assert.deepEqual(Object.fromEntries(docs.map(doc => [doc._id, doc.link?.method || null])), {
        'cognizant technology solutions us corp': 'name', 'globex systems inc': 'abbreviation', 'initech consulting services group l': 'prefix',
        'massive dynamic research laboratorie': null });

    // Overview: FY2023 (a partial archived year) is left out of the all-years totals.
    const overview = await uscis.getUscisOverview(db, {});
    assert.deepEqual(overview.trend.map(year => [year.fiscalYear, year.partial]), [[2016, false], [2022, false], [2023, true]]);
    assert.equal(overview.totals.initialApprovals, 80 + 5 + 100 + 10 + 3 + 1 + 2);
    assert.equal(overview.totalsExcludePartial, true);
    assert.equal((await uscis.getUscisOverview(db, { fy: '2023' })).totals.initialApprovals, 7);
    assert.equal((await uscis.getUscisOverview(db, { state: 'CA' })).totals.initialApprovals, 10);
    assert.equal((await uscis.getUscisOverview(db, { industry: '31-33' })).totals.initialApprovals, 10);
    await assert.rejects(uscis.getUscisOverview(db, { fy: '1999' }), { status: 400 });
    // A range: the partial year is left out unless it is the whole selection; reversed ends are swapped.
    const range = await uscis.getUscisOverview(db, { from: '2023', to: '2022' });
    assert.deepEqual([range.filters.from, range.filters.to, range.filters.whole], [2022, 2023, false]);
    assert.equal(range.totals.initialApprovals, 100 + 10 + 3 + 1 + 2);
    assert.equal(range.totalsExcludePartial, true);
    await assert.rejects(uscis.getUscisOverview(db, { from: '2030' }), { status: 400 });
    assert.deepEqual((await uscis.listUscisEmployers(db, { from: '2016', to: '2016', state: 'NJ' })).employers.map(row => row.approvals), [290]);
    assert.deepEqual((await uscis.listUscisEmployers(db, { from: '2022', to: '2023', q: 'cognizant' })).employers.map(row => row.approvals), [100 + 300 + 7 + 9]);

    // Employers: every-year ranking, filtered rankings, name search, denial rate, profile links.
    let list = await uscis.listUscisEmployers(db, {});
    assert.equal(list.employers[0].name, 'COGNIZANT TECHNOLOGY SOLUTIONS US CORP');
    assert.equal(list.employers[0].profile, slugFor('cognizant technology solutions us corp'));
    list = await uscis.listUscisEmployers(db, { fy: '2016', state: 'NJ' });
    assert.deepEqual(list.employers.map(row => [row.name, row.approvals]), [['COGNIZANT TECH SOLNS US CORP', 290]]);
    assert.deepEqual((await uscis.listUscisEmployers(db, { q: 'globex' })).employers.map(row => row.key), ['globex systems inc']);
    list = await uscis.listUscisEmployers(db, { sort: 'denialRate' });
    assert.equal(list.employers[0].key, 'massive dynamic research laboratorie', 'highest denial rate among names with 20+ decisions');
    assert.ok(list.employers.every(row => row.denialRate !== null));

    // Employer profiles collect every linked USCIS name.
    const profile = await uscis.uscisForIdentity(db, [idFor('cognizant technology solutions us corp')]);
    assert.deepEqual(profile.years.map(year => [year.fiscalYear, year.initialApprovals, year.partial]), [[2016, 85, false], [2022, 100, false], [2023, 7, true]]);
    assert.equal(await uscis.uscisForIdentity(db, [idFor('nobody')]), null);

    // Breakdowns by industry and by state, each following the other filter.
    const initialBy = result => Object.fromEntries(result.groups.map(group => [group.code, group.years.map(year => [year.fiscalYear, year.initialApprovals])]));
    assert.deepEqual(initialBy(await uscis.getUscisBreakdown(db, { by: 'industry' })), { '31-33': [[2022, 10]], 54: [[2016, 85], [2022, 106], [2023, 7]] });
    assert.deepEqual(initialBy(await uscis.getUscisBreakdown(db, { by: 'industry', state: 'CA', industry: '54' })), { '31-33': [[2022, 10]] }, 'the industry filter does not narrow an industry breakdown');
    await db.collection(uscis.ROWS).insertOne({ ...row(2022, 'NOWHERE LLC', [4, 0, 0, 0]), state: null });
    uscis.clearUscisCache();
    assert.deepEqual(initialBy(await uscis.getUscisBreakdown(db, { by: 'state', industry: '54' })), { NJ: [[2016, 85]], TX: [[2022, 106], [2023, 7]] }, 'rows without a state are left out');
    await db.collection(uscis.ROWS).deleteOne({ employer: 'NOWHERE LLC' });
    uscis.clearUscisCache();
    await assert.rejects(uscis.getUscisBreakdown(db, { by: 'city' }), { status: 400 });
    await assert.rejects(uscis.getUscisBreakdown(db, { by: 'state', industry: '00' }), { status: 400 });

    // Petitioners to compare: in the order asked, unknown names left out, at most four.
    const compared = await uscis.getUscisEmployerTrends(db, { employers: 'globex systems inc,nobody,cognizant technology solutions us corp' });
    assert.deepEqual(compared.employers.map(row => [row.key, row.years.map(year => [year.fiscalYear, year.initialApprovals])]),
        [['globex systems inc', [[2022, 10]]], ['cognizant technology solutions us corp', [[2016, 85], [2022, 100], [2023, 7]]]]);
    assert.equal(compared.employers[1].profile, slugFor('cognizant technology solutions us corp'));
    assert.deepEqual((await uscis.getUscisEmployerTrends(db, {})).employers, []);
    await assert.rejects(uscis.getUscisEmployerTrends(db, { employers: 'a,b,c,d,e' }), { status: 400 });

    // Replacing a year with a much smaller (filtered) export is refused.
    await assert.rejects(uscis.importUscisRows(db, [row(2022, 'GLOBEX SYSS INC', [1, 0, 0, 0])]), /under half/);
    assert.equal((await uscis.getUscisOverview(db, { fy: '2022' })).totals.initialApprovals, 100 + 10 + 3 + 1 + 2, 'the year is unchanged');

    // HTTP: public reads and an authenticated upload of a newer hub export.
    const app = express();
    app.use('/api/uscis-h1b', createUscisRoutes({ db: () => db, authMiddleware: (req, res, next) => req.headers.authorization === 'Bearer ok' ? next() : res.status(401).json({}) }));
    const server = app.listen(0); t.after(() => server.close());
    const base = `http://127.0.0.1:${server.address().port}/api/uscis-h1b`;
    assert.equal((await fetch(base + '?fy=2022').then(response => response.json())).totals.initialApprovals, 116);
    assert.equal((await fetch(base + '/employers?sort=nope')).status, 400);
    assert.deepEqual((await fetch(base + '/breakdown?by=state').then(response => response.json())).groups.map(group => group.code), ['CA', 'NJ', 'TX']);
    assert.equal((await fetch(base + '/compare?employers=globex%20systems%20inc').then(response => response.json())).employers[0].name, 'Globex Syss Inc');
    const types = ['New Employment', 'Continuation', 'Change with Same Employer', 'New Concurrent', 'Change of Employer', 'Amended'];
    const file = ['Fiscal Year\tEmployer (Petitioner) Name\tTax ID\tIndustry (NAICS) Code\tPetitioner City\tPetitioner State\tPetitioner Zip Code\t' + types.flatMap(type => [type + ' Approval', type + ' Denial']).join('\t'),
        '2025\tGlobex Systems Inc\t1234\t54\tOakland\tCA\t94607\t4\t1\t2\t0\t0\t0\t1\t0\t0\t0\t0\t0'].join('\n');
    const form = () => { const body = new FormData(); body.append('file', new Blob([file]), 'hub-fy2025.csv'); return body; };
    assert.equal((await fetch(base + '/import', { method: 'POST', body: form() })).status, 401);
    const accepted = await fetch(base + '/import', { method: 'POST', body: form(), headers: { Authorization: 'Bearer ok' } }).then(response => response.json());
    assert.deepEqual([accepted.rows, accepted.years, accepted.format], [1, [2025], 'petition-types']);
    for (let i = 0; i < 100 && (await db.collection('discovery_state').findOne({ _id: uscis.STATE_ID })).job?.state === 'importing'; i++) await new Promise(resolve => setTimeout(resolve, 100));
    const status = await uscis.getUscisStatus(db);
    assert.equal(status.job.state, 'ready');
    assert.deepEqual(status.years.map(year => [year.fiscalYear, year.partial, year.source.official]), [[2016, false, true], [2022, false, true], [2023, true, true], [2025, false, false]]);
    const globex = await db.collection(uscis.EMPLOYERS).findOne({ _id: 'globex systems inc' });
    // FY2025: new employment 4 and new concurrent 1 (initial); continuation 2 (continuing).
    assert.deepEqual(globex.years.map(year => [year.fiscalYear, year.initialApprovals, year.continuingApprovals]), [[2022, 10, 0], [2025, 5, 2]]);

    // Recomputing from stored petition types reproduces the same totals and leaves archived rows alone.
    await db.collection(uscis.ROWS).updateOne({ fiscalYear: 2025 }, { $set: { initialApprovals: 99 } });
    await uscis.recomputeUscisTotals(db);
    assert.deepEqual((await db.collection(uscis.EMPLOYERS).findOne({ _id: 'globex systems inc' })).years.map(year => [year.fiscalYear, year.initialApprovals, year.continuingApprovals]), [[2022, 10, 0], [2025, 5, 2]]);
});
