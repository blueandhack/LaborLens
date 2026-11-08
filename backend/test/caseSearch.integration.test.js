const { test } = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const { randomUUID } = require('crypto');
const { searchCases, buildSearch, invalidateCounts } = require('../services/caseSearch');
const { programs, searchIndexes } = require('../services/searchConfig');

test('covered search preserves matches, paging, dates and PWD links', { skip: !process.env.MONGO_TEST_URI }, async t => {
    const connection = await mongoose.createConnection(process.env.MONGO_TEST_URI, {
        dbName: 'laborlens_search_test_' + randomUUID().replaceAll('-', ''), autoIndex: false,
    }).asPromise();
    const models = {};
    t.after(async () => { invalidateCounts(); await connection.dropDatabase(); await connection.close(); });
    for (const [program, config] of Object.entries(programs)) {
        const Model = connection.model(program, new mongoose.Schema({}, { strict: false }), config.collection);
        models[program] = Model;
        await Model.collection.createIndex({ CASE_NUMBER: 1 }, { unique: true });
        for (const index of searchIndexes(program)) await Model.collection.createIndex(index.key, { name: index.name });
        await Model.collection.insertMany(Array.from({ length: 2000 }, (_, i) => ({
            CASE_NUMBER: `${i % 2 ? 'p' : 'P'}-${String(i).padStart(5, '0')}`,
            [config.company]: i < 1000 ? 'google llc' : 'other employer',
            [config.employer]: i < 1000 ? 'Google LLC' : 'Other employer',
            [config.city]: i % 4 === 3 ? 'california city' : i % 2 ? 'san jose' : 'austin', [config.state]: i % 2 ? 'Ca' : 'TX',
            JOB_TITLE: 'Software Engineer', JOB_TITLE_LOWER: 'software engineer',
            [config.date]: new Date(`202${i % 3 + 3}-06-30T00:00:00Z`), RECEIVED_DATE: new Date('2023-01-01'),
            JOB_OPP_PWD_NUMBER: program === 'perm' ? 'P-00000' : undefined,
            _DOL_ALTERNATE_RECORDS: [{ notes: 'x'.repeat(4096) }],
        })));
        await Model.collection.insertOne({ CASE_NUMBER: 'P-100-26092-750023',
            [config.company]: 'unique case fixture', [config.employer]: 'Unique case fixture',
            [config.city]: 'california city', [config.state]: 'CA',
            [config.date]: new Date('2026-06-30'), RECEIVED_DATE: new Date('2025-01-01') });
    }
    await t.test('matches and exact counts agree with original queries for every filter combination', async () => {
        for (const [program, config] of Object.entries(programs)) {
            for (const input of [{}, { company: 'GOO' }, { jobTitle: 'Software' }, { location: 'cA' },
                { location: 'San' }, { caseNumber: 'p-0000' }, { company: 'google', jobTitle: 'soft', location: 'ca' },
                { location: 'a', page: '2', limit: '12' }, { location: 'san', receivedYear: '2023' },
                { caseNumber: 'p-100-26092-750023', location: 'ca', receivedYear: '2025' },
                { [config.year]: '2025' }, { receivedYear: '2023' }, { company: 'no[match' }]) {
                invalidateCounts();
                const spec = buildSearch(program, input);
                const expected = await models[program].collection.find(spec.query).sort(spec.sort).skip(spec.skip).limit(spec.limit).toArray();
                const actual = await searchCases(models[program], program, input);
                assert.deepEqual(actual.cases.map(row => String(row._id)), expected.map(row => String(row._id)), `${program} ${JSON.stringify(input)}`);
                assert.equal(actual.totalCount, await models[program].collection.countDocuments(spec.query));
                assert.ok(actual.cases.every(row => row._DOL_ALTERNATE_RECORDS === undefined), 'large disclosure variants must not be loaded for cards');
            }
            // Compare optimized identifier/state prefixes with MongoDB's original /i semantics.
            for (const [parameter, field, value] of [['caseNumber', 'CASE_NUMBER', 'p-0000'], ['location', config.state, 'ca']]) {
                const result = await searchCases(models[program], program, { [parameter]: value });
                assert.equal(result.totalCount, await models[program].collection.countDocuments({ [field]: { $regex: '^' + value, $options: 'i' } }));
            }
        }
    });
    await t.test('employer and title selection use only indexes and fetch just one page afterward', async () => {
        for (const program of ['pwd', 'perm']) {
            const config = programs[program];
            for (const input of [{ company: 'google' }, { jobTitle: 'software' }]) {
                const spec = buildSearch(program, input);
                const plan = await models[program].collection.find(spec.query, {
                    projection: { _id: 1, [config.date]: 1 },
                }).sort(spec.sort).hint(spec.hint).limit(20).explain('executionStats');
                assert.equal(plan.executionStats.totalDocsExamined, 0, 'selection must never fetch matching full disclosures');
                assert.equal(plan.executionStats.nReturned, 20);
            }
        }
    });
    await t.test('combined and overlapping location filters never fetch whole matching disclosures', async () => {
        await connection.db.command({ profile: 2 });
        try {
            for (const program of ['pwd', 'perm']) for (const input of [
                { company: 'google', jobTitle: 'software', location: 'ca', receivedYear: '2023' },
                { jobTitle: 'software', location: 'ca' }, { location: 'ca' },
            ]) {
                invalidateCounts();
                await searchCases(models[program], program, input);
            }
        } finally { await connection.db.command({ profile: 0 }); }
        const reads = await connection.db.collection('system.profile').find({
            ns: { $in: [connection.name + '.cases', connection.name + '.permcases'] },
            $or: [{ 'command.find': { $exists: true } }, { 'command.aggregate': { $exists: true } }],
        }).toArray();
        assert.ok(reads.length > 10);
        for (const read of reads) assert.ok(read.docsExamined <= 20,
            `only displayed cards may fetch documents: ${JSON.stringify({ examined: read.docsExamined, command: read.command })}`);
    });
    await t.test('tie ordering is stable across pages and returned related PWD dates are preserved', async () => {
        const first = await searchCases(models.perm, 'perm', { company: 'google', limit: '12' });
        const second = await searchCases(models.perm, 'perm', { company: 'google', limit: '12', page: '2' });
        assert.equal(new Set([...first.cases, ...second.cases].map(row => String(row._id))).size, 24);
        assert.equal(first.cases[0].PWD_DETERMINATION_DATE.toISOString(), '2023-06-30T00:00:00.000Z');
        assert.equal(first.cases[0].PWD_RECEIVED_DATE.toISOString(), '2023-01-01T00:00:00.000Z');
        assert.equal(first.totalCount, 1000);
        assert.equal(first.totalPages, 84);
    });
    await t.test('punctuation-tolerant employer lookup uses the existing covering index for every program', async () => {
        for (const [program, config] of Object.entries(programs)) {
            await models[program].collection.insertMany(['Synthropic, Inc.', 'Synthropic INC', 'Synthropic-Inc'].map((name, i) => ({
                CASE_NUMBER: `synthropic-${i}`, [config.company]: name.toLowerCase(), [config.employer]: name,
                [config.date]: new Date('2025-01-01'), JOB_TITLE: 'Chief Executive Officer',
            })));
            invalidateCounts();
            const input = { company: 'Synthropic INC' };
            const result = await searchCases(models[program], program, input);
            assert.equal(result.totalCount, 3);
            const spec = buildSearch(program, input);
            const plan = await models[program].collection.find(spec.query, { projection: { _id: 1, [config.date]: 1 } })
                .sort(spec.sort).hint(spec.hint).limit(20).explain('executionStats');
            assert.equal(plan.executionStats.totalDocsExamined, 0);
            assert.equal(plan.executionStats.nReturned, 3);
            assert(plan.executionStats.totalKeysExamined < 20, 'a punctuation-tolerant lookup must retain a bounded employer-prefix index range');
        }
    });
    await t.test('aborted requests stop rather than continuing obsolete database work', async () => {
        const controller = new AbortController();
        controller.abort(new Error('Search replaced'));
        await assert.rejects(searchCases(models.pwd, 'pwd', { company: 'google' }, { signal: controller.signal }), /Search replaced/);
    });
    await t.test('a recent index window cannot hide older matches outside the window', async () => {
        const collection = models.pwd.collection;
        await collection.insertMany(Array.from({ length: 5001 }, (_, i) => ({
            CASE_NUMBER: `window-${i}`, EMPLOYER_NAME_LOWER: 'recent fixture',
            DETERMINATION_DATE: new Date('2026-01-01'), _PERF_WINDOW_FIXTURE: true,
        })));
        try {
            invalidateCounts();
            const result = await searchCases(models.pwd, 'pwd', { company: 'google' });
            assert.equal(result.totalCount, 1000);
            assert.equal(result.cases.length, 20, 'an incomplete window must fall back rather than truncate results');
            const expected = await collection.find({ EMPLOYER_NAME_LOWER: /^google/ })
                .sort({ DETERMINATION_DATE: -1, _id: 1 }).limit(20).toArray();
            assert.deepEqual(result.cases.map(row => String(row._id)), expected.map(row => String(row._id)));
        } finally { await collection.deleteMany({ _PERF_WINDOW_FIXTURE: true }); }
    });
});
