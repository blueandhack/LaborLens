const { test } = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const { randomUUID } = require('node:crypto');
const { programs, searchIndexes } = require('../services/searchConfig');
const { searchCases, buildSearch, countCases, invalidateCounts } = require('../services/caseSearch');
const { ensureEmployerIndexes, listEmployers } = require('../services/employers');
const { addWorksite } = require('../services/worksites');

const certDate = row => /^\s*certified\s*$/i.test(row.CASE_STATUS || '') ? row.DECISION_DATE : row.ORIGINAL_CERT_DATE;
const compare = (a, b, fields) => {
    for (const [field, direction] of Object.entries(fields)) {
        const x = field === '_id' ? String(a._id) : a[field]?.getTime() ?? null;
        const y = field === '_id' ? String(b._id) : b[field]?.getTime() ?? null;
        const order = x == null ? (y == null ? 0 : -1) : y == null ? 1 : x < y ? -1 : x > y ? 1 : 0;
        if (order) return order * direction;
    }
    return 0;
};

test('server sorting keeps certification semantics, missing dates, filters and stable full-dataset pages', { skip: !process.env.MONGO_TEST_URI }, async t => {
    const connection = await mongoose.createConnection(process.env.MONGO_TEST_URI, { dbName: 'sorting_' + randomUUID().replaceAll('-', ''), autoIndex: false }).asPromise();
    t.after(async () => { invalidateCounts(); await connection.dropDatabase(); await connection.close(); });
    const models = {};
    for (const [program, config] of Object.entries(programs)) {
        const Model = connection.model(program, new mongoose.Schema({}, { strict: false }), config.collection);models[program] = Model;
        await Model.collection.createIndex({ CASE_NUMBER: 1 }, { name: 'CASE_NUMBER_1', unique: true });
        for (const index of searchIndexes(program)) await Model.collection.createIndex(index.key, { name: index.name, ...(index.partialFilterExpression ? { partialFilterExpression: index.partialFilterExpression } : {}) });
        await Model.collection.insertMany(Array.from({ length: 2405 }, (_, i) => addWorksite({
            CASE_NUMBER: `${program}-${i}`, [config.company]: i === 0 ? 'only undated employer' : i % 3 ? 'example llc' : 'other llc', [config.employer]: i % 3 ? 'Example LLC' : 'Other LLC',
            [config.city]: 'austin', [config.state]: 'TX', JOB_TITLE: 'Engineer', JOB_TITLE_LOWER: 'engineer',
            [config.date]: i % 19 ? new Date(Date.UTC(2026 - i % 6, i % 4, 1)) : null,
            RECEIVED_DATE: i % 17 ? new Date(Date.UTC(2020 + i % 5, 0, 1)) : null,
            CASE_STATUS: ['Certified', ' Certified ', 'Certified-Withdrawn', 'Denied', 'Withdrawn'][i % 5],
            ORIGINAL_CERT_DATE: i % 5 === 2 && i % 11 ? new Date(Date.UTC(2010 + i % 14, 0, 1)) : null,
            WORKSITE_CITY: i % 2 ? 'California City' : 'San Jose', WORKSITE_STATE: 'CA', PRIMARY_WORKSITE_CITY: 'San Jose', PRIMARY_WORKSITE_STATE: 'CA',
            _DOL_ALTERNATE_RECORDS: [{ note: 'x'.repeat(2048) }],
        }, program)));
    }
    await t.test('all programs sort the entire match set in both directions, including deep and undated pages', async () => {
        for (const [program, Model] of Object.entries(models)) {
            const sorts = ['event_desc', 'event_asc', 'received_desc', 'received_asc', ...(program === 'h1b' ? ['certification_desc', 'certification_asc'] : [])];
            for (const sort of sorts) for (const filters of [{}, { company: 'example', worksite: 'CA', location: 'TX' }, { receivedYear: '2024' }, { company: 'only undated' }, { company: 'absent employer' }]) {
                const spec = buildSearch(program, { ...filters, sort });
                const matches = await Model.collection.find(spec.query).toArray();
                let expected;
                if (sort.startsWith('certification_')) {
                    const dated = matches.filter(row => certDate(row) instanceof Date).map(row => ({ ...row, cert: certDate(row) }));
                    expected = dated.sort((a, b) => compare(a, b, { cert: spec.direction, _id: -spec.direction }))
                        .concat(matches.filter(row => !(certDate(row) instanceof Date)).sort((a, b) => compare(a, b, { _id: 1 })));
                } else {
                    expected = matches.sort((a, b) => compare(a, b, spec.sort));
                    if (spec.direction === 1) expected = expected.filter(row => row[spec.sortField] instanceof Date)
                        .concat(expected.filter(row => !(row[spec.sortField] instanceof Date)).sort((a, b) => compare(a, b, { _id: 1 })));
                }
                for (const page of [...new Set([1, 2, 85, Math.ceil(expected.length / 24), Math.ceil(expected.length / 24) + 1])].filter(p => p > 0)) {
                    invalidateCounts();
                    const actual = await searchCases(Model, program, { ...filters, sort, page: String(page), limit: '24', count: 'deferred' });
                    const offset = (page - 1) * 24;
                    assert.deepEqual(actual.cases.map(row => String(row._id)), expected.slice(offset, offset + 24).map(row => String(row._id)), `${program} ${sort} ${JSON.stringify(filters)} page ${page}`);
                    assert.equal(actual.hasNextPage, expected.length > offset + 24);
                }
                assert.equal((await countCases(Model, program, { ...filters, sort })).totalCount, matches.length);
            }
        }
    });
    await t.test('long letter-heavy case prefixes retain exact matching and fast absent-result bounds', async () => {
        const collection = models.h1b.collection;
        await collection.insertMany(['ABCDEFRealValue', 'ABCDEFNotThis'].map(CASE_NUMBER => ({
            CASE_NUMBER, CASE_STATUS: 'Certified', DECISION_DATE: new Date('2025-01-01'), _LONG_CASE_FIXTURE: true,
        })));
        try {
            invalidateCounts();
            const result = await searchCases(models.h1b, 'h1b', { caseNumber: 'abcdefreal', sort: 'certification_desc', count: 'deferred' });
            assert.deepEqual(result.cases.map(row => row.CASE_NUMBER), ['ABCDEFRealValue']);
            assert.equal((await searchCases(models.h1b, 'h1b', { caseNumber: 'ZZZZ-NOT-A-CASE', sort: 'certification_asc', count: 'deferred' })).cases.length, 0);
        } finally { await collection.deleteMany({ _LONG_CASE_FIXTURE: true }); invalidateCounts(); }
    });
    await t.test('deep certification windows grow until older matching certifications are included', async () => {
        const collection = models.h1b.collection;
        const inserted = await collection.insertMany(Array.from({ length: 8500 }, (_, i) => ({
            CASE_NUMBER: 'window-' + i, EMPLOYER_NAME_LOWER: 'window fixture employer', EMPLOYER_NAME: 'Window Fixture Employer',
            CASE_STATUS: i < 2500 ? 'Certified' : 'Denied', DECISION_DATE: new Date(i < 2500 ? '2010-01-01' : '2026-01-01'),
            ORIGINAL_CERT_DATE: null, _SORT_WINDOW_FIXTURE: true,
        })));
        try {
            invalidateCounts();
            const result = await searchCases(models.h1b, 'h1b', { employer: 'window fixture employer', sort: 'certification_desc', count: 'deferred', page: '85', limit: '24' });
            assert.deepEqual(result.cases.map(row => String(row._id)), Array.from({ length: 24 }, (_, i) => String(inserted.insertedIds[2016 + i])));
            assert(result.cases.every(row => row.CASE_STATUS === 'Certified'), 'newer denials cannot hide older certifications beyond the initial source window');
            assert.equal(result.hasNextPage, true);
        } finally { await collection.deleteMany({ _SORT_WINDOW_FIXTURE: true }); invalidateCounts(); }
    });
    await t.test('certification selection reads covered metadata and fetches only the displayed disclosures', async () => {
        await connection.db.command({ profile: 2 });
        try {
            for (const sort of ['certification_desc', 'certification_asc']) for (const filters of [{}, { company: 'example', worksite: 'CA' }, { receivedYear: '2024' }, { company: 'only undated' }, { company: 'absent employer' }]) {
                invalidateCounts();await searchCases(models.h1b, 'h1b', { ...filters, sort, count: 'deferred', limit: '12' });
            }
        } finally { await connection.db.command({ profile: 0 }); }
        const reads = await connection.db.collection('system.profile').find({ ns: connection.name + '.h1bcases', $or: [{ 'command.find': { $exists: true } }, { 'command.aggregate': { $exists: true } }] }).toArray();
        assert(reads.length > 6);
        for (const read of reads) assert(read.docsExamined <= 12, JSON.stringify({ examined: read.docsExamined, command: read.command }));
    });
    await t.test('employer sorting is global, paginated, filterable and stable for tied volumes', async () => {
        await ensureEmployerIndexes(connection.db);
        const records = Array.from({ length: 80 }, (_, i) => ({ _id: String(i).padStart(24, '0'), key: `firm ${i}`, name: `Firm ${i}`, slug: `firm-${i}`, searchKey: `firm ${String(i).padStart(3, '0')}`,
            programs: { h1b: { count: i % 9 }, perm: { count: i % 7 }, pwd: { count: 80 - i } } }));
        await connection.db.collection('employers').insertMany(records);
        for (const sort of ['h1b_desc', 'perm_desc', 'pwd_desc', 'name_asc', 'name_desc']) for (const q of ['', 'firm 00']) {
            const program = sort.split('_')[0];
            const expected = records.filter(row => row.searchKey.startsWith(q)).sort((a, b) => sort.startsWith('name_')
                ? (sort === 'name_asc' ? 1 : -1) * a.searchKey.localeCompare(b.searchKey)
                : b.programs[program].count - a.programs[program].count || a.searchKey.localeCompare(b.searchKey));
            for (const page of [1, 2, 4, 5]) {
                const result = await listEmployers(connection.db, { sort, q, page: String(page) });
                assert.deepEqual(result.employers.map(row => row.id), expected.slice((page - 1) * 24, page * 24).map(row => row._id));
                assert.equal(result.hasNextPage, expected.length > page * 24);
            }
        }
        for (const input of [{ sort: 'wage' }, { sort: ['$ne'] }, { page: '-1' }, { page: '1e100' }, { q: { $ne: '' } }]) await assert.rejects(listEmployers(connection.db, input), error => error.status === 400);
    });
});
