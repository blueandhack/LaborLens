import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getEmployerSEO, getPageSEO } from '../src/utils/seo.js';
import { readSearchState, writeSearchState } from '../src/utils/searchState.js';

test('complete employer profiles have their own canonical identity; pending summaries remain noindex', () => {
  const profile = { name: 'Synthropic, Inc.', slug: 'synthropic-inc--' + 'a'.repeat(24), ready: true, snapshotAt: '2026-11-08T00:00:00Z' };
  const seo = getEmployerSEO(profile);
  assert.match(seo.title, /Synthropic, Inc.*H1B.*PERM/);
  assert.equal(seo.canonical, 'https://laborlens.fyi/employers/' + profile.slug);
  assert.equal(seo.robots, 'index, follow');
  assert.equal(getEmployerSEO({ ...profile, ready: false }).robots, 'noindex, follow');
  assert.equal(getPageSEO('/employers').robots, 'index, follow');
  for (const query of ['?employer=synthropic', '?worksite=CA']) assert.equal(getPageSEO('/h1b', query).robots, 'noindex, follow');
});
test('exact employer selection and separate worksite/employer locations survive URL navigation', () => {
  const params = new URLSearchParams('company=Synthropic&employer=synthropic%2C+inc.&location=TX&worksite=CA&page=2&limit=48');
  const { filters, page, limit } = readSearchState(params, 'h1b');
  assert.equal(filters.employer, 'synthropic, inc.');
  assert.equal(filters.location, 'TX'); assert.equal(filters.worksite, 'CA');
  const roundTrip = writeSearchState(filters, page, limit);
  assert.equal(roundTrip.get('employer'), filters.employer); assert.equal(roundTrip.get('worksite'), 'CA');
  assert.equal(roundTrip.get('location'), 'TX'); assert.equal(roundTrip.get('page'), '2');
  const stored = ' Amazon.com Services LLC\t';
  const exact = writeSearchState({ employer: stored }, 1, 24);
  assert.equal(exact.get('employer'), stored, 'source spacing must survive profile-to-case URLs');
  assert.equal(readSearchState(exact, 'h1b').filters.employer, stored);
});
