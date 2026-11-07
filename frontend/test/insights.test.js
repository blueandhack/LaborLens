import { test } from 'node:test';
import assert from 'node:assert/strict';
import { calendarSeries, outcomeTicks, statusLabel } from '../src/utils/insights.js';

test('calendar plots preserve count totals, include gaps and handle a single year or no dates', () => {
  const series = calendarSeries([{ year: 2023, count: 20 }, { year: 2025, count: 5 }]);
  assert.deepEqual(series, [{ year: 2023, count: 20 }, { year: 2024, count: 0 }, { year: 2025, count: 5 }]);
  assert.equal(series.reduce((sum, row) => sum + row.count, 0), 25);
  assert.deepEqual(calendarSeries([]), []);
  assert.deepEqual(calendarSeries([{ year: 2025, count: 1 }]), [{ year: 2025, count: 1 }]);
});

test('outcome tick areas encode the exact share without rounding small categories away', () => {
  for (const [count, total] of [[1, 1000], [33, 100], [100, 100], [0, 0], [0, 100]]) {
    const ticks = outcomeTicks(count, total);
    assert.ok(ticks.length <= 50 && ticks.every(value => value > 0 && value <= 1));
    assert.ok(Math.abs(ticks.reduce((sum, value) => sum + value, 0) - (total ? count / total * 50 : 0)) < 1e-9);
  }
  assert.equal(statusLabel('CERTIFIED-EXPIRED'), 'Certified-Expired');
  assert.equal(statusLabel('NOT REPORTED'), 'Not Reported');
});
