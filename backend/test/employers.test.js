const { test } = require('node:test');
const assert = require('node:assert/strict');
const { slugFor, searchKey, idFor } = require('../services/employers');
const { worksite, addWorksite } = require('../services/worksites');
const { buildSearch } = require('../services/caseSearch');

test('discovery tolerates punctuation without merging reported-name identities', () => {
    assert.equal(searchKey('Synthropic, INC.'), searchKey('synthropic inc'));
    assert.notEqual(idFor('synthropic, inc.'), idFor('synthropic inc'));
    assert.match(slugFor('synthropic, inc.'), /^synthropic-inc--[a-f0-9]{24}$/);
    assert.notEqual(slugFor('name & sons'), slugFor('name-and-sons'));
    assert.match(slugFor('公司'), /^employer--[a-f0-9]{24}$/);
});
test('worksites use reported primary locations, preserve source fields and never substitute employer addresses', () => {
    const raw = { EMPLOYER_CITY: 'Austin', EMPLOYER_STATE: 'TX', WORKSITE_CITY: '  Montréal  ', WORKSITE_STATE: 'QC' };
    const record = addWorksite({ ...raw }, 'h1b');
    assert.equal(record._WORKSITE_CITY_LOWER, 'montréal');
    assert.equal(record.WORKSITE_CITY, raw.WORKSITE_CITY);
    assert.deepEqual(worksite({ EMPLOYER_CITY: 'Austin', EMPLOYER_STATE: 'TX' }, 'h1b'), { city: null, state: null });
    assert.deepEqual(worksite({ PRIMARY_WORKSITE_CITY: '', WORKSITE_CITY: 'Boston', WORKSITE_STATE: 'MA' }, 'pwd'), { city: 'Boston', state: 'MA' });
    assert.deepEqual(worksite({ JOB_INFO_WORK_CITY: 'Denver', JOB_INFO_WORK_STATE: 'CO' }, 'perm'), { city: 'Denver', state: 'CO' });
});
test('exact reported names do not broaden into prefixes and worksite branches keep all other filters', () => {
    const spec = buildSearch('h1b', { employer: 'Synthropic, Inc.', company: 'Synthropic', location: 'TX', worksite: 'CA', jobTitle: 'Engineer' });
    assert.equal(spec.query.$and[0].EMPLOYER_NAME_LOWER, 'synthropic, inc.');
    assert.deepEqual(spec.branchHints, ['search_worksite_city_v1', 'search_worksite_state_v1']);
    assert.equal(spec.branches.length, 2);
    assert.equal(spec.branches[0].$and.at(-1)._WORKSITE_CITY_LOWER.$regex, '^ca');
    assert(spec.branches[0].$and.some(condition => condition.$or));
    assert.throws(() => buildSearch('pwd', { worksite: ['$ne'] }), error => error.status === 400);
});
