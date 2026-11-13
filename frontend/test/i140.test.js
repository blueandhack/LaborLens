import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readI140State, writeI140State, denialRate, quarterMonths, quarterLabel, levelOf, titleCase, backlogMonths, categorySummary, awaitingColumns, suggestedCompare, formatMonths } from '../src/utils/i140Presentation.js';
import { getPageSEO } from '../src/utils/seo.js';

test('I-140 page state, quarters and rates', () => {
  assert.deepEqual(readI140State(new URLSearchParams('category=niw&country=India')), { category: 'niw', country: 'India', from: '', to: '', compare: null, metric: 'received' });
  assert.deepEqual(readI140State(new URLSearchParams('category=bogus')), { category: 'all', country: '', from: '', to: '', compare: null, metric: 'received' });
  assert.equal(writeI140State({ category: 'all', country: '' }).toString(), '');
  assert.equal(quarterMonths(2026, 1), 'Oct–Dec 2025', 'fiscal year 2026 starts in October 2025');
  assert.equal(quarterMonths(2026, 3), 'Apr–Jun 2026');
  assert.equal(quarterLabel(2026, 3), 'Q3 FY26');
  assert.equal(denialRate(0, 0), null);
  assert.equal(denialRate(3, 1), 0.25);
  assert.equal(levelOf([{ code: 'niw', level: 'eb2' }], 'niw'), 'eb2');
  assert.equal(titleCase('BOSNIA AND HERZEGOVINA'), 'Bosnia and Herzegovina');
});

test('I-140 comparisons and the saved category', () => {
  const state = readI140State(new URLSearchParams('compare=niw,eb1a,bogus,niw,eb2a,eb3,eb1&metric=backlog'));
  assert.deepEqual(state.compare, ['niw', 'eb1a', 'eb2a', 'eb3'], 'unknown and repeated codes are dropped, and at most four kept');
  assert.equal(state.metric, 'backlog');
  assert.equal(readI140State(new URLSearchParams('metric=bogus')).metric, 'received');
  assert.equal(writeI140State({ category: 'niw', compare: ['niw', 'eb1a'], metric: 'rate' }).toString(), 'category=niw&compare=niw%2Ceb1a&metric=rate');
  assert.equal(writeI140State({ category: 'niw', compare: null, metric: 'received' }).toString(), 'category=niw', 'suggested comparisons stay out of the address');
  // A saved category opens when the address names none; "All" is then written out so it stays chosen.
  assert.equal(readI140State(new URLSearchParams(''), 'niw').category, 'niw');
  assert.equal(readI140State(new URLSearchParams('category=all'), 'niw').category, 'all');
  assert.equal(readI140State(new URLSearchParams(''), 'bogus').category, 'all');
  assert.equal(writeI140State({ category: 'all' }, 'niw').toString(), 'category=all');
  assert.equal(writeI140State({ category: 'all' }, '').toString(), '');
  assert.deepEqual(suggestedCompare('niw'), ['niw', 'eb1a', 'eb2a']);
  assert.deepEqual(suggestedCompare('all'), ['eb1', 'eb2', 'eb3']);
});

test('I-140 backlog, period summaries and visa-backlog columns', () => {
  const quarter = (received, approved, denied, pending) => ({ categories: { niw: { received, approved, denied, pending } } });
  const quarters = [quarter(100, 40, 10, 300), quarter(120, 50, 10, 360), quarter(150, 30, 30, 450), quarter(160, 20, 20, 590), quarter(200, 10, 30, 750)];
  assert.equal(backlogMonths(quarters, 0, 'niw'), null, 'one quarter is too little to set a pace');
  // Last four quarters decided 60, 60, 40, 40: 50 a quarter, so 750 pending is 15 quarters, 45 months.
  assert.equal(backlogMonths(quarters, 4, 'niw'), 45);
  assert.equal(backlogMonths([quarter(1, 0, 0, 5), quarter(1, 0, 0, 5)], 1, 'niw'), null, 'no decisions, no pace');
  const summary = categorySummary(quarters, 3, 4, 'niw');
  assert.equal(summary.received, 360);
  assert.equal(summary.rate, 50 / 80);
  assert.equal(summary.pending, 750);
  assert.equal(summary.receivedChange, 360 / 270 - 1, 'compared with the two quarters before');
  assert.equal(summary.rateBefore, 40 / 120);
  assert.equal(categorySummary(quarters, 2, 4, 'niw').receivedChange, null, 'no earlier period of the same length');
  const labels = ['1st (Priority)', '2nd (Advanced Degree Professional)', '3rd (Professional and Skilled)', '3rd (Other)', '4th (Certain Special Immigrants)', 'TOTAL'];
  assert.deepEqual([...awaitingColumns(labels, 'niw', 'eb2')], [1]);
  assert.deepEqual([...awaitingColumns(labels, 'eb1a', 'eb1')], [0]);
  assert.deepEqual([...awaitingColumns(labels, 'eb3', 'eb3')], [2, 3]);
  assert.deepEqual([...awaitingColumns(labels, 'eb3u', 'eb3')], [3]);
  assert.deepEqual([...awaitingColumns(labels, 'eb3p', 'eb3')], [2]);
  assert.deepEqual([...awaitingColumns(labels, 'all', 'all')], []);
  assert.equal(formatMonths(43.2), '43 months');
  assert.equal(formatMonths(0.4), 'under a month');
  assert.equal(formatMonths(null), '—');
});

test('the I-140 page is indexed only in its default view', () => {
  assert.equal(getPageSEO('/i140').canonical, 'https://laborlens.fyi/i140');
  assert.equal(getPageSEO('/i140', '?category=niw').robots, 'noindex, follow');
  assert.equal(getPageSEO('/i140', '?metric=backlog').robots, 'noindex, follow');
});
