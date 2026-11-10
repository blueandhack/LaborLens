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

test('USCIS tax-ID links join renames but not campuses, peers, umbrellas or conflicting FEINs', () => {
    const { taxIdLinks, baseName, nested } = require('../services/employerIdentity');
    assert.equal(baseName('salesforce com inc'), 'salesforce com');
    assert(nested('anthropic pbc', 'anthropic pbc dba anthropic inc')); assert(!nested('salesforce org inc', 'salesforce com inc'));
    const at = date => new Date(date).getTime();
    const activity = new Map(Object.entries({
        'salesforce com inc': { total: 17000, latest: at('2022-09-30') }, 'salesforce inc': { total: 13000, latest: at('2026-06-30') },
        'salesforce com': { total: 3800, latest: at('2022-04-02') }, 'salesforce org inc': { total: 36, latest: at('2019-05-31') },
        'anthropic pbc': { total: 351, latest: at('2026-06-01') }, 'anthropic pbc dba anthropic inc': { total: 35, latest: at('2026-05-01') },
        'acme labs inc': { total: 400, latest: at('2026-06-01') }, 'acme robotics inc': { total: 300, latest: at('2026-05-01') },
        'nova data inc': { total: 50, latest: at('2018-01-01') }, 'nova cloud inc': { total: 60, latest: at('2026-01-01') },
        'university of x at north': { total: 900, latest: at('2021-01-01') }, 'university of x at south': { total: 300, latest: at('2026-01-01') },
        'zeta one inc': { total: 10, latest: at('2015-01-01') }, 'zeta two inc': { total: 10, latest: at('2026-01-01') },
        'omega a inc': { total: 10, latest: at('2015-01-01') }, 'omega b inc': { total: 10, latest: at('2026-01-01') },
    }));
    const name = (nameKey, first, last) => ({ nameKey, first, last });
    const { links, umbrellas } = taxIdLinks([
        // The rename (and the older suffix-less PERM spelling) share a tax ID; Salesforce.org reports its own.
        // A branch office ZIP is shared too, but the link cites the ZIP where both names petition most.
        { taxId: '0693', zip: '22102', names: [{ ...name('salesforce com inc', 2009, 2023), weight: 3 }, { ...name('salesforce inc', 2022, 2026), weight: 2 }] },
        { taxId: '0693', zip: '94105', names: [{ ...name('salesforce com inc', 2009, 2023), weight: 900 }, { ...name('salesforce inc', 2022, 2026), weight: 700 }, name('salesforce com', 2009, 2013), name('salesforcecom inc', 2019, 2019)] },
        { taxId: '9769', zip: '94105', names: [name('salesforce org inc', 2017, 2019), name('salesforce org', 2019, 2019)] },
        // A dba used alongside the main name, a minor variant whose words the main name's extend.
        { taxId: '6045', zip: '94104', names: [name('anthropic pbc', 2021, 2026), name('anthropic pbc dba anthropic inc', 2022, 2025)] },
        // Two names filing side by side are peers, not a rename.
        { taxId: '1111', zip: '10001', names: [name('acme labs inc', 2015, 2026), name('acme robotics inc', 2016, 2026)] },
        // A hand-over with too many shared fiscal years.
        { taxId: '2222', zip: '10002', names: [name('nova data inc', 2010, 2020), name('nova cloud inc', 2016, 2026)] },
        // Campuses of a system never link as a rename.
        { taxId: '3333', zip: '10003', names: [name('university of x at north', 2009, 2020), name('university of x at south', 2025, 2026)] },
        // Many unrelated first words on one tax ID and ZIP: a shared office.
        { taxId: '4444', zip: '10004', names: ['zeta one inc', 'zeta two inc', 'alpha inc', 'beta inc', 'gamma inc'].map(key => name(key, 2010, 2012)) },
        // Different DOL FEINs veto the link.
        { taxId: '5555', zip: '10005', names: [name('omega a inc', 2009, 2012), name('omega b inc', 2020, 2026)] },
    ], activity, { dominantFein: new Map([['omega a inc', '111111111'], ['omega b inc', '222222222']]) });
    const pairs = links.map(link => [link.a, link.b].sort().join(' + ')).sort();
    assert.deepEqual(pairs, ['anthropic pbc + anthropic pbc dba anthropic inc', 'salesforce com + salesforce com inc', 'salesforce com inc + salesforce inc']);
    assert.equal(umbrellas, 1);
    const rename = links.find(link => link.b === 'salesforce inc');
    assert.deepEqual([rename.taxId, rename.zip, rename.years], ['0693', '94105', [[2009, 2023], [2022, 2026]]]);
});
