import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classBreaks, classOf, rampStep, legendEntries, formatMetric, placeSearchURL, principalCity, readMapState, writeMapState, rankPlaces, bubbleRadius,
  fitBox, zoomPath, placeLabels, FULL_VIEW } from '../src/utils/mapPresentation.js';
import { readSearchState } from '../src/utils/searchState.js';
import { getPageSEO } from '../src/utils/seo.js';

test('quantile classes spread places across the ramp', () => {
  const breaks = classBreaks([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, null]);
  assert.deepEqual(breaks, [1, 3, 5, 7, 9, 10]);
  assert.deepEqual([1, 2, 3, 9, 10].map(value => classOf(value, breaks)), [1, 1, 2, 5, 5]);
  assert.equal(classOf(null, breaks), 0);
  // Two distinct values use the ends of the ramp; a single value the middle.
  const two = classBreaks([5, 5, 5, 9]);
  assert.deepEqual([classOf(5, two), classOf(9, two)].map(index => rampStep(index, two)), [1, 5]);
  assert.equal(rampStep(classOf(4, classBreaks([4, 4])), classBreaks([4, 4])), 3);
  assert.deepEqual(legendEntries('median', [80000, 100000, 150000]).map(entry => entry.label), ['$80k–$100k', '$100k–$150k']);
  assert.equal(bubbleRadius(25, 100, 20), 10);
});

test('formats and rankings', () => {
  assert.equal(formatMetric('count', 12345), '12,345');
  assert.equal(formatMetric('perCapita', 3.456), '3.5');
  assert.equal(formatMetric('median', 123456), '$123,456');
  assert.equal(formatMetric('senior', 0.456), '46%');
  assert.equal(formatMetric('median', null), 'Not enough data');
  const rows = [{ name: 'A', count: 100, median: 90000 }, { name: 'B', count: 10, median: 200000 }, { name: 'C', count: 60, median: 120000 }];
  assert.deepEqual(rankPlaces(rows, 'median', 'metros').map(row => row.name), ['C', 'A'], 'small places are not ranked by a median');
  assert.deepEqual(rankPlaces(rows, 'count', 'metros').map(row => row.name), ['A', 'C', 'B']);
});

test('places link to case search with the worksite state', () => {
  assert.equal(principalCity('Seattle-Tacoma-Bellevue, WA'), 'Seattle');
  assert.equal(placeSearchURL('h1b', { kind: 'state', code: 'CA' }, { year: '2024' }), '/h1b?worksiteState=CA&decisionYear=2024');
  assert.equal(placeSearchURL('pwd', { kind: 'metro', name: 'Seattle-Tacoma-Bellevue, WA', state: 'WA' }, { year: 'all' }), '/?worksiteState=WA&worksite=Seattle');
  assert.equal(placeSearchURL('perm', { kind: 'state', code: 'TX' }, { employer: { groupId: 'abc', name: 'Acme' } }), '/perm?employerGroup=abc&company=Acme&worksiteState=TX');
  assert.equal(readSearchState(new URLSearchParams('worksiteState=WA&worksite=Seattle'), 'h1b').filters.worksiteState, 'WA');
});

test('map state round-trips through the URL and filtered views are not indexed', () => {
  const state = readMapState(new URLSearchParams('program=perm&year=2024&occupation=15-1252&metric=median&view=metros'));
  assert.deepEqual(state, { program: 'perm', year: '2024', occupation: '15-1252', metric: 'median', view: 'metros', state: '', county: '', city: '' });
  assert.equal(writeMapState(state).toString(), 'program=perm&year=2024&occupation=15-1252&metric=median&view=metros');
  assert.equal(writeMapState(readMapState(new URLSearchParams('program=x&metric=bad'))).toString(), '');
  const zoomed = readMapState(new URLSearchParams('state=CA&county=06085&city=San+Jose'));
  assert.deepEqual([zoomed.state, zoomed.county, zoomed.city], ['CA', '06085', 'san jose']);
  assert.equal(writeMapState(zoomed).toString(), 'state=CA&county=06085&city=san+jose');
  assert.deepEqual(['county', 'city'].map(key => readMapState(new URLSearchParams('county=06085&city=x'))[key]), ['', ''], 'counties and cities need a state');
  assert.equal(readMapState(new URLSearchParams('state=california')).state, '');
  assert.equal(getPageSEO('/map').robots, 'index, follow');
  assert.equal(getPageSEO('/map').canonical, 'https://laborlens.fyi/map');
  assert.equal(getPageSEO('/map', '?view=metros').robots, 'noindex, follow');
  assert.equal(getPageSEO('/h1b', '?worksiteState=CA').robots, 'noindex, follow');
});

test('cities and counties link to case search in their state', () => {
  assert.equal(placeSearchURL('h1b', { kind: 'city', name: 'San Jose', state: 'CA' }, { year: '2025' }), '/h1b?worksiteState=CA&worksite=San+Jose&decisionYear=2025');
  assert.equal(placeSearchURL('perm', { kind: 'county', code: '06085', name: 'Santa Clara County', state: 'CA' }), '/perm?worksiteState=CA');
});

test('zoom boxes keep the map aspect ratio and zoom paths end exactly on target', () => {
  const [x, y, width, height] = fitBox([100, 100, 200, 120], { padding: 0 });
  assert.ok(Math.abs(width / height - 975 / 610) < 1e-9);
  assert.equal(width, 100); assert.ok(Math.abs(x + width / 2 - 150) < 1e-9 && Math.abs(y + height / 2 - 110) < 1e-9);
  assert.equal(fitBox([10, 10, 10, 10], { padding: 0, minimum: 5 })[2], 5, 'a point gets the minimum size');
  const path = zoomPath(FULL_VIEW, fitBox([30, 250, 60, 290]));
  assert.deepEqual(path.at(1), fitBox([30, 250, 60, 290]));
  assert.ok(path.at(0).every((value, index) => Math.abs(value - FULL_VIEW[index]) < 1e-6));
  const middle = path.at(0.5);
  assert.ok(middle[2] < 975 && middle[2] > fitBox([30, 250, 60, 290])[2], 'zooms in progressively');
  assert.ok(path.duration >= 450 && path.duration <= 1400);
  assert.ok(zoomPath(FULL_VIEW, [0, 0, 487.5, 305]).at(0.5)[2] < 975, 'pure zoom without panning');
});

test('labels skip places that would overlap a larger place’s label', () => {
  const labels = placeLabels([
    { id: 'a', x: 0, y: 0, r: 1, label: 'San Jose' }, { id: 'b', x: 1, y: 0.2, r: 1, label: 'Santa Clara' }, { id: 'c', x: 0, y: 30, r: 1, label: 'Fremont' },
  ], { font: 10, limit: 5 });
  assert.deepEqual(labels.map(item => item.id), ['a', 'c']);
  assert.equal(placeLabels([{ id: 'a', x: 0, y: 0, r: 1, label: 'A' }, { id: 'c', x: 0, y: 300, r: 1, label: 'C' }], { font: 10, limit: 1 }).length, 1);
});
