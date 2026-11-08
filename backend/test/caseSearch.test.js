const { test } = require('node:test');
const assert = require('node:assert/strict');
const { buildSearch } = require('../services/caseSearch');
const { BoundedCache } = require('../services/boundedCache');

test('search bounds page size and rejects malformed filters instead of unbounded queries', () => {
    for (const input of [{ limit: '0' }, { limit: '10000' }, { page: '-1' }, { page: '1e100' },
        { company: ['$ne'] }, { company: { $ne: '' } }, { company: 'a'.repeat(161) },
        { receivedYear: '2026junk' }, { determinationYear: '0' }]) {
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
        assert.equal(spec.hint, 'search_company_v3');
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
