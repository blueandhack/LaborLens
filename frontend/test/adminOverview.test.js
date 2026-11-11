import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatBytes, formatCompact, formatDuration, timeAgo, healthChecks, overallLevel, describeActivity, groupActivity } from '../src/utils/adminOverview.js';

const now = Date.parse('2026-11-10T12:00:00Z');
const hoursAgo = hours => new Date(now - hours * 3600000).toISOString();

test('sizes, counts, durations and relative times read naturally', () => {
  assert.equal(formatBytes(5740065237), '5.3 GB'); assert.equal(formatBytes(512), '512 B'); assert.equal(formatBytes(null), '—');
  assert.equal(formatCompact(9378443), '9.38M'); assert.equal(formatCompact(16924336), '16.9M'); assert.equal(formatCompact(45000), '45k'); assert.equal(formatCompact(950), '950');
  assert.equal(formatDuration(1733), '28m 53s'); assert.equal(formatDuration(103888), '1d 4h'); assert.equal(formatDuration(5), '5s');
  assert.equal(timeAgo(hoursAgo(3), now), '3 hours ago'); assert.equal(timeAgo(hoursAgo(-49), now), 'in 2 days');
  assert.equal(timeAgo(hoursAgo(0.001), now), 'just now'); assert.equal(timeAgo(null, now), '—');
});

test('health checks flag failures, stale jobs and pressure in plain words', () => {
  const healthy = {
    jobs: { refresh: { outcome: 'succeeded', finishedAt: hoursAgo(5) }, imports: { latest: { status: 'done', startedAt: hoursAgo(20) } },
      backup: { state: 'succeeded', lastSuccess: { completedAt: hoursAgo(24 * 9) } } },
    database: { cache: { used: 300, max: 400 } }, server: { container: { used: 150, limit: 800 } }, security: { failedSignIns24h: 1, blockedAddresses: 0 },
  };
  const checks = healthChecks(healthy, now);
  assert.equal(overallLevel(checks), 'ok');
  assert.deepEqual(checks.map(check => check.id), ['refresh', 'imports', 'backup', 'cache', 'server', 'security']);
  assert.equal(checks.find(check => check.id === 'cache').detail, '75% of cache in use');
  const failing = healthChecks({ ...healthy, jobs: { ...healthy.jobs, backup: { state: 'failed', error: 'Drive token expired' } } }, now);
  assert.equal(overallLevel(failing), 'error');
  assert.deepEqual(failing.find(check => check.id === 'backup'), { id: 'backup', level: 'error', label: 'Last backup failed', detail: 'Drive token expired' });
  const stale = healthChecks({ ...healthy, jobs: { ...healthy.jobs, backup: { state: 'succeeded', lastSuccess: { completedAt: hoursAgo(24 * 60) } } } }, now);
  assert.equal(overallLevel(stale), 'warning');
  assert.equal(healthChecks({ ...healthy, jobs: { ...healthy.jobs, backup: null } }, now).find(check => check.id === 'backup').level, 'warning');
});

test('activity entries describe imports, refreshes and admin events', () => {
  assert.deepEqual(describeActivity({ kind: 'import', files: 12, outcomes: { unchanged: 11, imported: 1 } }),
    { tone: 'ok', title: 'Automatic import', detail: '1 imported · 12 releases checked' });
  assert.equal(describeActivity({ kind: 'import', files: 3, outcomes: { error: 1, unchanged: 2 } }).tone, 'error');
  assert.deepEqual(describeActivity({ kind: 'admin', type: 'username-changed', username: 'yoga', from: 'admin' }), { tone: 'ok', title: 'Username changed', detail: 'admin → yoga' });
  assert.deepEqual(describeActivity({ kind: 'admin', type: 'sign-in-failed', unknownAccount: true }), { tone: 'error', title: 'Failed sign-in', detail: 'unknown account' });
  assert.equal(describeActivity({ kind: 'refresh', outcome: 'succeeded', steps: ['Worksite map'] }).detail, 'Worksite map');
});

test('back-to-back activity that reads the same folds into one counted entry', () => {
  const run = hours => ({ kind: 'import', mode: 'backfill', at: hoursAgo(hours), files: 78, outcomes: { 'already-imported': 78 } });
  const failed = (hours, ip) => ({ kind: 'admin', type: 'sign-in-failed', at: hoursAgo(hours), username: 'admin', ip, userAgent: 'curl' });
  const groups = groupActivity([run(1), run(2), run(3), { kind: 'refresh', at: hoursAgo(4), outcome: 'succeeded', steps: ['Worksite map'] }, run(5),
    failed(6, '203.0.113.1'), failed(7, '203.0.113.1'), failed(8, '203.0.113.2')]);
  assert.deepEqual(groups.map(group => [group.title, group.count]), [
    ['Automatic import (backfill)', 3], ['Background refresh', 1], ['Automatic import (backfill)', 1], ['Failed sign-in', 2], ['Failed sign-in', 1]]);
  assert.equal(groups[0].newest, hoursAgo(1));
  assert.equal(groups[0].oldest, hoursAgo(3));
  assert.deepEqual(groupActivity([]), []);
});

test('the status lists administrators without two-factor sign-in, and new account events read plainly', () => {
  const base = { jobs: {}, security: { failedSignIns24h: 0, blockedAddresses: 0 } };
  const off = healthChecks({ ...base, security: { ...base.security, admins: [{ username: 'yoga', twoFactor: true }, { username: 'ops', twoFactor: false }] } }, now);
  assert.deepEqual(off.find(check => check.id === 'two-factor'), { id: 'two-factor', level: 'warning', label: 'Two-factor sign-in', detail: 'Off for ops' });
  const on = healthChecks({ ...base, security: { ...base.security, admins: [{ username: 'yoga', twoFactor: true }] } }, now);
  assert.equal(on.find(check => check.id === 'two-factor').level, 'ok');
  assert.deepEqual(describeActivity({ kind: 'admin', type: 'sign-out', username: 'yoga' }), { tone: 'ok', title: 'Signed out', detail: 'yoga' });
  assert.equal(describeActivity({ kind: 'admin', type: 'two-factor-disabled', username: 'yoga' }).tone, 'warning');
  assert.deepEqual(describeActivity({ kind: 'admin', type: 'data-cleared', username: 'yoga', program: 'pwd', records: 1200 }), { tone: 'warning', title: 'Data cleared', detail: 'yoga · PWD · 1,200 records' });
});
