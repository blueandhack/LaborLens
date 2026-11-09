import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readUscisState, writeUscisState, apiQuery, formatRate, niceMax, seriesValues, coverageLabel, location } from '../src/utils/uscisPresentation.js';
import { getPageSEO } from '../src/utils/seo.js';

test('page state round-trips through the URL, keeping only non-default values', () => {
  const state = readUscisState(new URLSearchParams('from=2019&to=2021&state=TX&industry=31-33&q=acme&sort=denialRate&page=3'));
  assert.deepEqual(state, { from: '2019', to: '2021', state: 'TX', industry: '31-33', q: 'acme', sort: 'denialRate', page: 3 });
  assert.equal(writeUscisState(state).toString(), 'from=2019&to=2021&state=TX&industry=31-33&q=acme&sort=denialRate&page=3');
  const defaults = readUscisState(new URLSearchParams('fy=nope&state=texas&sort=bogus&page=-2'));
  assert.deepEqual(defaults, { from: '', to: '', state: '', industry: '', q: '', sort: 'approvals', page: 1 });
  assert.equal(writeUscisState(defaults).toString(), '');
  assert.equal(apiQuery({ ...defaults, state: 'CA' }, ['fy', 'state', 'industry']), 'state=CA');
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
});
