const { test } = require('node:test');
const assert = require('node:assert/strict');
const { buildSearch, searchCases, countCases, invalidateCounts } = require('../services/caseSearch');
const { BoundedCache } = require('../services/boundedCache');
const { indexNames } = require('../services/searchConfig');

test('search bounds page size and rejects malformed filters instead of unbounded queries', () => {
    for (const input of [{ limit: '0' }, { limit: '10000' }, { page: '-1' }, { page: '1e100' },
        { company: ['$ne'] }, { company: { $ne: '' } }, { company: 'a'.repeat(161) },
        { receivedYear: '2026junk' }, { determinationYear: '0' }, { sort: ['event_desc'] }, { sort: 'wage' }, { sort: 'certification_desc' }]) {
        assert.throws(() => buildSearch('pwd', input), error => error.status === 400);
    }
    assert.equal(buildSearch('pwd', { page: '3', limit: '48' }).skip, 96);
    assert.equal(buildSearch('pwd', {}).limit, 20);
    const specific = buildSearch('pwd', { caseNumber: 'p-100-26092-750023', receivedYear: '2025', location: 'ca' });
    assert.equal(specific.hint, 'CASE_NUMBER_1', 'a specific case number must win over broad year/location indexes');
    assert.equal(specific.branches, null);
});

test('employer prefixes tolerate punctuation and dates retain calendar semantics', () => {
    const spec = buildSearch('perm', { company: ' A.B+ ', decisionYear: '2025' });
    assert.equal(spec.query.$and[0].EMP_BUSINESS_NAME_LOWER.$regex, '^a[^\\p{L}\\p{N}]*b');
    assert.deepEqual(spec.query.$and[1].DECISION_DATE, { $gte: new Date('2025-01-01'), $lt: new Date('2026-01-01') });
    assert.deepEqual(spec.sort, { DECISION_DATE: -1, _id: 1 });
});

test('employer matching handles Synthropic punctuation variants without losing an indexed leading prefix', () => {
    for (const query of ['Synthropic INC', 'Synthropic, Inc.', 'synthropic-inc']) {
        const spec = buildSearch('h1b', { company: query });
        const expression = spec.query.$and[0].EMPLOYER_NAME_LOWER.$regex;
        assert(expression.startsWith('^synthropic'));
        const pattern = new RegExp(expression, 'u');
        for (const name of ['synthropic, inc.', 'synthropic inc', 'synthropic-inc']) assert(pattern.test(name));
        assert.equal(pattern.test('another synthropic inc'), false);
        assert.equal(spec.hint, indexNames.company);
    }
    assert.equal(buildSearch('h1b', { company: '.*' }).query.$and[0].EMPLOYER_NAME_LOWER.$regex, '^\\.\\*');
    assert.equal(buildSearch('h1b', { jobTitle: 'C++' }).query.$and[0].JOB_TITLE_LOWER.$regex, '^c\\+\\+');
});

test('bounded count cache coalesces, evicts, expires and fences invalidated loads', async () => {
    const cache = new BoundedCache({ capacity: 2, ttlMs: 1000 });
    let calls = 0;
    const load = async () => ++calls;
    assert.deepEqual(await Promise.all([cache.get('a', load), cache.get('a', load)]), [1, 1]);
    await cache.get('b', load);
    await cache.get('c', load);
    assert.equal(cache.values.size, 2);
    assert.equal(cache.values.has('a'), false);
    cache.values.get('b').expires = 0;
    assert.equal(cache.peek('b'), undefined);
    assert.equal(await cache.get('b', load), 4);
    let resolve;
    const waiting = cache.get('pending', () => new Promise(done => { resolve = done; }));
    await Promise.resolve();
    cache.clear();
    resolve(9);
    assert.equal(await waiting, 9);
    assert.equal(cache.values.size, 0);
    await assert.rejects(cache.get('failed', () => Promise.reject(new Error('failed'))), /failed/);
    assert.equal(cache.pending.size, 0);
});

function pageModel(length = 25) {
    const rows = Array.from({ length }, (_, i) => ({ _id: String(i), CASE_NUMBER: `P-${i}` }));
    return { collection: {
        find(query) {
            let skip = 0, limit = rows.length;
            const cursor = {
                sort() { return cursor; }, skip(value) { skip = value; return cursor; },
                limit(value) { limit = value; return cursor; },
                async toArray() { return query._id ? rows.filter(row => query._id.$in.includes(row._id)) : rows.slice(skip, skip + limit); },
            };
            return cursor;
        },
        countDocuments() { throw new Error('Case retrieval must not count'); },
        estimatedDocumentCount() { throw new Error('Case retrieval must not count'); },
    } };
}

test('deferred cases and next-page state return while a shared total is still blocked', { timeout: 2000 }, async () => {
    invalidateCounts();
    const Model = pageModel();
    let finish;
    Model.collection.estimatedDocumentCount = () => new Promise(resolve => { finish = resolve; });
    const counting = countCases(Model, 'pwd', {});
    await Promise.resolve();
    try {
        const first = await searchCases(Model, 'pwd', { count: 'deferred', limit: '24' });
        assert.equal(first.cases.length, 24);
        assert.equal(first.hasNextPage, true);
        assert.equal(first.totalCount, null);
        assert.equal(first.totalPages, null);
        const last = await searchCases(Model, 'pwd', { count: 'deferred', limit: '24', page: '2' });
        assert.deepEqual(last.cases.map(row => row._id), ['24']);
        assert.equal(last.hasNextPage, false);
        finish(25);
        assert.deepEqual(await counting, { totalCount: 25 });
        assert.equal((await searchCases(Model, 'pwd', { count: 'deferred' })).totalCount, 25);
    } finally { finish(25); await counting; invalidateCounts(); }
});

test('unknown totals distinguish an empty first page, an exact page boundary, and an outside page', async () => {
    for (const [length, page, expected, next] of [[0, '1', 0, false], [24, '1', 24, false], [25, '2', 1, false], [24, '3', 0, false]]) {
        invalidateCounts();
        const result = await searchCases(pageModel(length), 'pwd', { count: 'deferred', page, limit: '24' });
        assert.equal(result.cases.length, expected);
        assert.equal(result.hasNextPage, next);
        assert.equal(result.totalCount, page === '1' ? length : null);
    }
    await assert.rejects(searchCases(pageModel(), 'pwd', { count: ['deferred'] }), error => error.status === 400);
});

test('expensive total concurrency is bounded without blocking case retrieval', async () => {
    invalidateCounts();
    const Model = pageModel();
    const finishes = [];
    Model.collection.countDocuments = () => new Promise(resolve => finishes.push(resolve));
    const one = countCases(Model, 'pwd', { company: 'one' });
    const shared = countCases(Model, 'pwd', { company: 'one' });
    const two = countCases(Model, 'pwd', { company: 'two' });
    await Promise.resolve();
    try {
        assert.equal(finishes.length, 2, 'identical filters must coalesce');
        await assert.rejects(countCases(Model, 'pwd', { company: 'three' }), error => error.status === 503);
        assert.equal((await searchCases(Model, 'pwd', { count: 'deferred' })).cases.length, 20);
    } finally { finishes.forEach(resolve => resolve(0)); await Promise.all([one, shared, two]); }
    assert.equal((await searchCases(Model, 'pwd', { company: 'one', count: 'deferred' })).totalCount, 0);
    invalidateCounts();
});
