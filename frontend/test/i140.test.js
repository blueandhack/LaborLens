import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readI140State, writeI140State, denialRate, quarterMonths, quarterLabel, levelOf, titleCase } from '../src/utils/i140Presentation.js';
import { getPageSEO } from '../src/utils/seo.js';

test('I-140 page state, quarters and rates', () => {
  assert.deepEqual(readI140State(new URLSearchParams('category=niw&country=India')), { category: 'niw', country: 'India', from: '', to: '' });
  assert.deepEqual(readI140State(new URLSearchParams('category=bogus')), { category: 'all', country: '', from: '', to: '' });
  assert.equal(writeI140State({ category: 'all', country: '' }).toString(), '');
  assert.equal(quarterMonths(2026, 1), 'Oct–Dec 2025', 'fiscal year 2026 starts in October 2025');
  assert.equal(quarterMonths(2026, 3), 'Apr–Jun 2026');
  assert.equal(quarterLabel(2026, 3), 'Q3 FY26');
  assert.equal(denialRate(0, 0), null);
  assert.equal(denialRate(3, 1), 0.25);
  assert.equal(levelOf([{ code: 'niw', level: 'eb2' }], 'niw'), 'eb2');
  assert.equal(titleCase('BOSNIA AND HERZEGOVINA'), 'Bosnia and Herzegovina');
});

test('the I-140 page is indexed only in its default view', () => {
  assert.equal(getPageSEO('/i140').canonical, 'https://laborlens.fyi/i140');
  assert.equal(getPageSEO('/i140', '?category=niw').robots, 'noindex, follow');
});
