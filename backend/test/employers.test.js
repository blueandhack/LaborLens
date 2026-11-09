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
test('exact reported names do not broaden into prefixes and worksite queries keep all other filters', () => {
    const spec = buildSearch('h1b', { employer: 'Synthropic, Inc.', company: 'Synthropic', location: 'TX', worksite: 'CA', jobTitle: 'Engineer' });
    assert.equal(spec.query.$and[0].EMPLOYER_NAME_LOWER, 'synthropic, inc.');
    const locations = spec.query.$and.filter(condition => condition.$or).flatMap(condition => condition.$or);
    assert(locations.some(condition => condition._WORKSITE_CITY_LOWER?.$regex === '^ca'));
    assert(locations.some(condition => condition.EMPLOYER_CITY_LOWER?.$regex === '^tx'));
    assert(spec.query.$and.some(condition => condition.JOB_TITLE_LOWER?.$regex === '^engineer'));
    assert.throws(() => buildSearch('pwd', { worksite: ['$ne'] }), error => error.status === 400);
    assert.equal(buildSearch('h1b', { employer: ' Amazon.com Services LLC\t' }).query.$and[0].EMPLOYER_NAME_LOWER, ' amazon.com services llc\t');
});

test('identity names normalize spelling and abbreviations but keep the legal form', () => {
    const { nameKey, normalizeFein, feinLinks } = require('../services/employerIdentity');
    for (const variant of ['COGNIZANT TECHNOLOGY SOLUTIONS U.S. CORPORATION', 'Cognizant Technology Solutions US Corp.', ' cognizant technology solutions us corporation\t'])
        assert.equal(nameKey(variant), 'cognizant technology solutions us corp');
    assert.equal(nameKey('Tech Mahindra ( Americas),Inc.'), nameKey('tech mahindra (americas) inc'));
    assert.equal(nameKey('Ernst &Young U.S. LLP'), nameKey('ernst and young us llp'));
    assert.equal(nameKey('The Société Générale'), nameKey('societe generale'));
    assert.equal(nameKey('IBM India Pvt. Ltd.'), nameKey('ibm india private limited'));
    assert.notEqual(nameKey('Acme Widgets LLC'), nameKey('Acme Widgets, Inc.'));
    assert.notEqual(nameKey('Infosys BPM Limited'), nameKey('Infosys Limited'));
    assert.equal(normalizeFein('20-1665019'), '201665019');
    for (const invalid of ['000000000', '123456789', '12-34', null]) assert.equal(normalizeFein(invalid), null);
    const row = (name, fein, count, zips) => ({ nameKey: name, fein, count, zips });
    const { links, umbrellas } = feinLinks([
        row('facebook inc', '20-1665019', 1, ['94025']), row('facebook inc', '99-0000001', 0, []),
        row('meta platforms inc', '201665019', 500, ['94025']),
        row('typo inc', '201665019', 2, ['10001']),
        row('big a inc', '30-0000001', 40, ['11111']), row('big b inc', '30-0000001', 30, ['22222']),
        row('fmr llc', '04-3532603', 3126, ['2210']), row('fmr llc dba fidelity investments', '043532603', 918, ['02210']),
        row('mostly other inc', '201665019', 3, ['94025']), row('mostly other inc', '40-0000001', 7, ['94025']),
        ...Array.from({ length: 7 }, (_, i) => row(`campus ${i}`, '50-0000001', 3, ['33333'])),
    ]);
    const pairs = links.map(link => [link.a, link.b].sort().join(' + ')).sort();
    assert.deepEqual(pairs, ['facebook inc + meta platforms inc', 'fmr llc + fmr llc dba fidelity investments'], 'volume without a shared ZIP is not a link');
    assert.deepEqual(umbrellas.map(item => item.fein), ['500000001']);
});
