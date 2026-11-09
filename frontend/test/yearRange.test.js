import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeRange, rangeParams, inRange } from '../src/utils/yearRange.js';
import { readUscisState, writeUscisState } from '../src/utils/uscisPresentation.js';
import { readI140State, writeI140State } from '../src/utils/i140Presentation.js';

const years = [2009, 2010, 2011, 2012, 2013];

test('fiscal-year ranges: defaults, clamping, swapping and URL values', () => {
  assert.deepEqual(normalizeRange(years, '', ''), { from: 2009, to: 2013, whole: true, single: false });
  assert.deepEqual(normalizeRange(years, '2012', '2010'), { from: 2010, to: 2012, whole: false, single: false });
  assert.deepEqual(normalizeRange(years, '1990', '2011'), { from: 2009, to: 2011, whole: false, single: false });
  assert.equal(normalizeRange(years, '2011', '2011').single, true);
  assert.deepEqual(rangeParams(years, 2009, 2011), { from: '', to: '2011' }, 'an end at the bound stays out of the URL');
  assert.ok(inRange(2010, normalizeRange(years, '2010', '2010')));
});

test('the H-1B page reads ranges, and earlier single-year links', () => {
  assert.deepEqual([readUscisState(new URLSearchParams('fy=2019')).from, readUscisState(new URLSearchParams('fy=2019')).to], ['2019', '2019']);
  const state = readUscisState(new URLSearchParams('from=2015&to=2020&state=TX'));
  assert.equal(writeUscisState(state).toString(), 'from=2015&to=2020&state=TX');
  assert.equal(writeI140State({ ...readI140State(new URLSearchParams('from=2012&category=niw')) }).toString(), 'category=niw&from=2012');
});
