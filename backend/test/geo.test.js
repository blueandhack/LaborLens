const { test } = require('node:test');
const assert = require('node:assert/strict');
const geo = require('../services/geo');
const { mapParameters } = require('../services/map');

test('states normalize from postal codes and names; search matches both stored forms', () => {
    assert.equal(geo.stateCode('ca'), 'CA');
    assert.equal(geo.stateCode('California'), 'CA');
    assert.equal(geo.stateCode(' new  york '), 'NY');
    assert.equal(geo.stateCode('district of columbia'), 'DC');
    assert.equal(geo.stateCode('Ontario'), null);
    assert.deepEqual(geo.stateValues('ca').slice(0, 2), ['ca', 'california']);
    assert.equal(geo.stateValues('ZZ'), null);
});

test('ZIP codes map to 2023 metro areas, including Connecticut planning regions', () => {
    assert.equal(geo.zipCode('98052-6399'), '98052');
    assert.equal(geo.zipCode(2134), '02134', 'a ZIP stored as a number regains its leading zero');
    assert.equal(geo.zipCode('N/A'), null);
    assert.equal(geo.metroForZip('98052'), '42660');
    assert.equal(geo.metros.get('42660').name, 'Seattle-Tacoma-Bellevue, WA');
    assert.equal(geo.metroForZip('06103'), '25540', 'Hartford uses its 2023 metro');
    assert.equal(geo.metroForZip('10001'), '35620');
    // A ZIP whose state contradicts the reported state is not trusted.
    assert.deepEqual(geo.locate({ z: '98052', s: 'tx', c: 'redmond' }), { state: 'TX', metro: null });
    assert.deepEqual(geo.locate({ z: '98052', s: 'washington', c: '' }), { state: 'WA', metro: '42660' });
});

test('occupation codes from SOC 2000, 2010 and O*NET map to SOC 2018', () => {
    assert.equal(geo.occupationCode('15-1252.00'), '15-1252');
    assert.equal(geo.occupationCode('15-1132'), '15-1252');
    assert.equal(geo.occupationCode('151133'), '15-1252');
    assert.equal(geo.occupationCode('15-1031.00'), '15-1252', 'SOC 2000 software engineers');
    assert.equal(geo.occupationCode('15-1199.01'), '15-1299');
    assert.equal(geo.occupationCode('13-2011'), '13-2011');
    assert.equal(geo.occupationCode(''), null);
    assert.equal(geo.occupationTitle('15-1252'), 'Software Developers');
});

test('wage levels, medians and learned city areas', () => {
    assert.deepEqual(['I', 'Level II', 'LEVEL III', 'iv', 'Level V', 'N/A', ''].map(geo.wageLevel), [1, 2, 3, 4, null, null, null]);
    const bins = geo.histogram();
    bins[50] = 3; bins[60] = 1; // $100,000–$101,999 ×3, $120,000 ×1
    assert.equal(geo.median(bins), 101300);
    assert.equal(geo.median(geo.histogram()), null);
    const cities = new geo.CityMetros();
    cities.learn('WA', 'Seattle', '42660', 9); cities.learn('WA', 'Seattle', '14740', 1);
    cities.learn('WA', 'Kent', '42660', 3); // too few cases
    cities.learn('NY', 'Springfield', '1', 3); cities.learn('NY', 'Springfield', '2', 3); // no consensus
    cities.finish();
    assert.equal(cities.get('WA', ' SEATTLE '), '42660');
    assert.equal(cities.get('WA', 'Kent'), null);
    assert.equal(cities.get('NY', 'Springfield'), null);
    assert.equal(new geo.CityMetros(cities.toJSON()).get('WA', 'seattle'), '42660');
});

test('map parameters are validated', () => {
    assert.deepEqual(mapParameters({}), { program: 'h1b', year: 'all', occupation: 'all' });
    assert.deepEqual(mapParameters({ program: 'perm', year: '2024', occupation: '15-1252' }), { program: 'perm', year: 2024, occupation: '15-1252' });
    for (const input of [{ program: 'x' }, { year: '24' }, { occupation: '151252' }, { year: ['2024'] }]) assert.throws(() => mapParameters(input), /Invalid/);
});
