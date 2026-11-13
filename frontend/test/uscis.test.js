import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readUscisState, writeUscisState, apiQuery, formatRate, niceMax, seriesValues, coverageLabel, location, viewOf, countedYears, priorYears, groupSummary, sumYears, uscisBreakdownURL, uscisCompareURL } from '../src/utils/uscisPresentation.js';
import { getPageSEO } from '../src/utils/seo.js';

test('page state round-trips through the URL, keeping only non-default values', () => {
  const state = readUscisState(new URLSearchParams('from=2019&to=2021&state=TX&industry=31-33&q=acme&sort=denialRate&page=3'));
  assert.deepEqual(state, { from: '2019', to: '2021', state: 'TX', industry: '31-33', q: 'acme', sort: 'denialRate', page: 3, by: 'industry', industries: [], states: [], employers: [], metric: 'approvals' });
  assert.equal(writeUscisState(state).toString(), 'from=2019&to=2021&state=TX&industry=31-33&q=acme&sort=denialRate&page=3');
  const defaults = readUscisState(new URLSearchParams('fy=nope&state=texas&sort=bogus&page=-2'));
  assert.deepEqual(defaults, { from: '', to: '', state: '', industry: '', q: '', sort: 'approvals', page: 1, by: 'industry', industries: [], states: [], employers: [], metric: 'approvals' });
  assert.equal(writeUscisState(defaults).toString(), '');
  assert.equal(apiQuery({ ...defaults, state: 'CA' }, ['fy', 'state', 'industry']), 'state=CA');
});

test('comparisons: chosen groups, the kept view and the request addresses', () => {
  const state = readUscisState(new URLSearchParams('by=employer&industries=54,51,54,bad&states=WA,ca,TX&employers=acme corp,globex inc&metric=initialRate&from=2020&q=ac'));
  assert.deepEqual([state.by, state.industries, state.states, state.employers, state.metric], ['employer', ['54', '51'], ['WA', 'TX'], ['acme corp', 'globex inc'], 'initialRate']);
  assert.deepEqual(readUscisState(new URLSearchParams('employers=a,b,c,d,e')).employers, ['a', 'b', 'c', 'd'], 'at most four');
  assert.equal(readUscisState(new URLSearchParams('by=city&metric=nope')).by, 'industry');
  // The kept view leaves out the years, search and page.
  assert.equal(viewOf({ ...state, state: 'WA' }), 'state=WA&by=employer&industries=54%2C51&states=WA%2CTX&employers=acme+corp%2Cglobex+inc&metric=initialRate');
  assert.equal(viewOf(readUscisState(new URLSearchParams('from=2020&q=x'))), '');
  assert.equal(uscisBreakdownURL({ by: 'industry', state: 'WA', industry: '54' }), '/api/uscis-h1b/breakdown?by=industry&state=WA');
  assert.equal(uscisBreakdownURL({ by: 'state', state: 'WA', industry: '31-33' }), '/api/uscis-h1b/breakdown?by=state&industry=31-33');
  assert.equal(uscisCompareURL(['acme corp', 'globex inc']), '/api/uscis-h1b/compare?employers=acme+corp%2Cglobex+inc');
});

test('comparison totals: counted years, the period before, and rates with enough decisions', () => {
  const years = [2018, 2019, 2020, 2021, 2022, 2023].map(fiscalYear => ({ fiscalYear, partial: fiscalYear === 2023 }));
  assert.deepEqual(countedYears(years, 2021, 2023), [2021, 2022], 'a partial year is left out of a range');
  assert.deepEqual(countedYears(years, 2023, 2023), [2023], 'but counts on its own');
  assert.deepEqual(priorYears(years, [2021, 2022]), [2019, 2020]);
  assert.equal(priorYears(years, [2019, 2020, 2021]), null, 'not enough earlier years');
  const rows = [
    { fiscalYear: 2019, initialApprovals: 40, initialDenials: 10, continuingApprovals: 50, continuingDenials: 0 },
    { fiscalYear: 2021, initialApprovals: 60, initialDenials: 20, continuingApprovals: 80, continuingDenials: 5 },
    { fiscalYear: 2022, initialApprovals: 30, initialDenials: 0, continuingApprovals: 10, continuingDenials: 0 },
  ];
  const summary = groupSummary(rows, [2021, 2022], [2019, 2020]);
  assert.equal(summary.approvals, 180);
  assert.equal(summary.initialRate, 20 / 110);
  assert.equal(summary.continuingRate, 5 / 95);
  assert.equal(summary.change, 180 / 90 - 1);
  assert.equal(sumYears(rows, [2022]).rate, 0, 'zero denials of 40 decisions');
  assert.equal(sumYears([{ fiscalYear: 2022, initialApprovals: 5, initialDenials: 5, continuingApprovals: 0, continuingDenials: 0 }], [2022]).rate, null, 'fewer than 20 decisions');
  assert.equal(groupSummary(rows, [2019], [2018]).change, null, 'nothing approved before');
});

test('rates, scales and labels', () => {
  assert.equal(formatRate(0.2432), '24.3%');
  assert.equal(formatRate(0.02), '2.0%');
  assert.equal(formatRate(null), '—');
  assert.equal(niceMax(487000), 500000);
  assert.equal(niceMax(0.243), 0.25);
  assert.deepEqual(seriesValues({ initialApprovals: 3, initialDenials: 1, continuingApprovals: 0, continuingDenials: 0 }).continuing, { approvals: 0, denials: 0, rate: null });
  const years = [{ fiscalYear: 2009 }, { fiscalYear: 2022 }, { fiscalYear: 2023, partial: true }];
  assert.equal(coverageLabel(years), 'FY2009–FY2023');
  assert.equal(coverageLabel(years, { excludePartial: true }), 'FY2009–FY2022');
  assert.equal(location({ city: 'COLLEGE STATION', state: 'TX' }), 'College Station, TX');
});

test('the approvals page is indexed only in its default view', () => {
  const page = getPageSEO('/h1b-approvals');
  assert.equal(page.canonical, 'https://laborlens.fyi/h1b-approvals');
  assert.match(page.title, /H1B Approval & Denial Rates/);
  assert.equal(page.robots, 'index, follow');
  assert.equal(getPageSEO('/h1b-approvals', '?fy=2020').robots, 'noindex, follow');
  assert.equal(getPageSEO('/h1b-approvals', '?by=state').robots, 'noindex, follow');
});
