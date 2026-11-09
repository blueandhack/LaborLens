import { test } from 'node:test';
import assert from 'node:assert/strict';
import { describeEvent, formatDuration, mapState, refreshState } from '../src/utils/siteStatusPresentation.js';

test('refresh and map states', () => {
  assert.equal(refreshState(null).label, 'No run recorded yet');
  assert.deepEqual(refreshState({ running: true, interrupted: true }), { label: 'Interrupted', tone: 'error' });
  assert.equal(refreshState({ running: true }).tone, 'active');
  assert.equal(refreshState({ outcome: 'failed' }).label, 'Last run failed');
  const built = { updatedAt: '2026-11-09', total: 10, located: 9 };
  assert.equal(mapState({ build: null, built: null }).label, 'Not built');
  assert.equal(mapState({ build: { state: 'building', phase: 'Summarizing occupations', completed: 26, of: 300 }, built }).detail, 'Summarizing occupations · 26 of 300 occupations');
  assert.equal(mapState({ build: { state: 'building', interrupted: true, phase: 'Learning worksite cities' }, built }).label, 'Interrupted');
  assert.equal(mapState({ build: { state: 'failed', error: 'boom' }, built }).detail, 'boom');
  assert.equal(mapState({ build: { state: 'ready' }, built, upToDate: false }).label, 'Out of date');
  assert.equal(mapState({ build: { state: 'unchanged' }, built, upToDate: true }).label, 'Current');
});

test('durations and progress events read naturally', () => {
  assert.equal(formatDuration(20000), 'under a minute');
  assert.equal(formatDuration(25 * 60000), '25 min');
  assert.equal(formatDuration(125 * 60000), '2 h 5 min');
  assert.equal(describeEvent({ event: 'map-occupations', program: 'h1b', completed: 26, of: 300 }), 'Worksite map · H-1B: 26 of 300 occupations');
  assert.equal(describeEvent({ event: 'directory', program: 'perm', employers: 250000 }), 'Employer directory · PERM: 250,000 names');
  assert.equal(describeEvent({ event: 'something-new' }), 'something new');
  assert.equal(describeEvent(null), null);
});
