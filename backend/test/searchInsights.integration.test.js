const { test } = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const { randomUUID } = require('crypto');
const { programs, searchIndexes } = require('../services/searchConfig');
const { buildSearch } = require('../services/caseSearch');
const { computeInsights, getSearchInsights, noteInsightsChange, refreshGlobalInsights, invalidateInsights } = require('../services/searchInsights');

test('insights count every matching case with bounded covered reads and safe snapshots', { skip: !process.env.MONGO_TEST_URI }, async t => {
    const connection = await mongoose.createConnection(process.env.MONGO_TEST_URI, {
        dbName: 'laborlens_insights_test_' + randomUUID().replaceAll('-', ''), autoIndex: false,
    }).asPromise();
    t.after(async () => { invalidateInsights(); await connection.dropDatabase(); await connection.close(); });
    const models = {};
    for (const [program, config] of Object.entries(programs)) {
        const Model = connection.model(program, new mongoose.Schema({}, { strict: false }), config.collection);
        models[program] = Model;
        await Model.collection.createIndex({ CASE_NUMBER: 1 }, { unique: true });
        for (const index of searchIndexes(program)) await Model.collection.createIndex(index.key, { name: index.name });
        await Model.collection.insertMany(Array.from({ length: 160 }, (_, i) => ({
            CASE_NUMBER: `P-100-${String(i).padStart(8, '0')}`,
            [config.company]: i < 120 ? 'example llc' : 'other employer',
            [config.city]: i % 3 ? 'california city' : 'austin', [config.state]: i % 2 ? 'Ca' : 'TX',
            JOB_TITLE_LOWER: 'software engineer', RECEIVED_DATE: new Date('2023-01-01'),
            [config.date]: i % 11 === 0 ? null : i % 11 === 1 ? '2024-05-01' : new Date(`202${i % 3 + 3}-06-30`),
            CASE_STATUS: ['Certified', ' certified ', 'Certified-Expired', 'Denied', 'Withdrawn', null, '', 'Pending', 'Reconsideration'][i % 9],
            _DOL_ALTERNATE_RECORDS: [{ notes: 'x'.repeat(8192) }],
        })));
    }
    await t.test('all filters match search semantics, regardless of pagination or view', async () => {
        for (const [program, config] of Object.entries(programs)) {
            for (const input of [{ company: 'EXAMPLE', page: '999', limit: '1', view: 'cards' },
                { jobTitle: 'software', location: 'ca' }, { location: 'ca' }, { company: 'example', location: 'ca', receivedYear: '2023' },
                { [config.year]: '2024' }, { caseNumber: 'p-100-00000001' }, { company: 'no[match' }]) {
                const result = await computeInsights(models[program], program, input);
                const expected = await models[program].collection.find(buildSearch(program, input).query).toArray();
                assert.equal(result.totalCount, expected.length, `${program}: ${JSON.stringify(input)}`);
                assert.equal(result.timeline.reduce((sum, row) => sum + row.count, result.missingDateCount), result.totalCount);
                assert.equal(result.outcomes.reduce((sum, row) => sum + row.count, 0), result.totalCount);
                assert.ok(result.outcomes.length <= 7);
            }
            const result = await computeInsights(models[program], program, { company: 'example' });
            assert.ok(result.totalCount > 20, 'entire search, not the visible page');
            assert.ok(result.missingDateCount > 0, 'null and string dates are explicitly excluded');
            assert.ok(result.outcomes.some(row => row.status === 'CERTIFIED-EXPIRED'), 'qualified statuses are never collapsed into approvals');
            assert.ok(result.outcomes.some(row => row.other), 'small statuses retain counts in Other');
            assert.equal(result.outcomes.find(row => row.status === 'CERTIFIED').count, 28);
        }
    });
    await t.test('analytics scan indexes without loading large disclosures', async () => {
        await connection.db.command({ profile: 2 });
        try {
            for (const program of ['pwd', 'perm']) for (const input of [{}, { company: 'example' },
                { jobTitle: 'software', location: 'ca' }, { location: 'ca' }]) {
                await computeInsights(models[program], program, input);
            }
        } finally { await connection.db.command({ profile: 0 }); }
        const reads = await connection.db.collection('system.profile').find({ 'command.comment': 'laborlens-search-insights' }).toArray();
        assert.equal(reads.length, 10);
        for (const row of reads) assert.equal(row.docsExamined, 0, `covered analytics: ${row.planSummary}`);
    });
    await t.test('same filters share cached computation and concurrent distinct work is refused', async () => {
        invalidateInsights();
        const [first, second] = await Promise.all([
            getSearchInsights(models.pwd, 'pwd', { company: 'example', page: '1' }),
            getSearchInsights(models.pwd, 'pwd', { company: 'example', page: '200' }),
        ]);
        assert.deepEqual(first, second);
        const running = computeInsights(models.pwd, 'pwd', {});
        await assert.rejects(computeInsights(models.perm, 'perm', {}), error => error.status === 503);
        await running;
        const controller = new AbortController(); controller.abort(new Error('Replaced search'));
        await assert.rejects(getSearchInsights(models.pwd, 'pwd', {}, { signal: controller.signal }), /Replaced search/);
    });
    await t.test('snapshots are instant, become stale after writes, and cannot resurrect cleared data', async () => {
        assert.equal((await refreshGlobalInsights(models.pwd, 'pwd')).published, true);
        const initial = await getSearchInsights(models.pwd, 'pwd', {});
        assert.equal(initial.source, 'snapshot'); assert.equal(initial.stale, false);
        await noteInsightsChange(connection.db, 'pwd');
        assert.equal((await getSearchInsights(models.pwd, 'pwd', {})).stale, true);
        assert.equal((await refreshGlobalInsights(models.pwd, 'pwd')).published, true);
        assert.equal((await refreshGlobalInsights(models.pwd, 'pwd')).unchanged, true);
        // Interleave a clear at the refresh's final compare-and-set write.
        const state = connection.collection('search_insights');
        const original = state.updateOne.bind(state);
        state.updateOne = async (filter, update, options) => {
            if (update.$set?.snapshot) await noteInsightsChange(connection.db, 'pwd', { clear: true });
            return original(filter, update, options);
        };
        try { assert.equal((await refreshGlobalInsights(models.pwd, 'pwd', { force: true })).published, false); }
        finally { state.updateOne = original; }
        assert.equal((await connection.db.collection('search_insights').findOne({ _id: 'pwd' })).snapshot, undefined);
        const empty = await computeInsights(models.pwd, 'pwd', { company: 'absent' });
        assert.equal(empty.totalCount, 0); assert.deepEqual(empty.timeline, []); assert.deepEqual(empty.outcomes, []);
    });
});
