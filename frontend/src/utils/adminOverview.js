import { describeSecurityEvent } from './adminSecurity.js';

// Formatting and health checks for the administration overview.
export const REPOSITORY = 'https://github.com/blueandhack/LaborLens';

export function formatBytes(bytes) {
  if (bytes === null || bytes === undefined || !Number.isFinite(bytes)) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes, unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit++; }
  return `${value >= 100 || unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

export const formatCount = value => value === null || value === undefined ? '—' : Number(value).toLocaleString('en-US');
export function formatCompact(value) {
  if (value === null || value === undefined) return '—';
  if (value >= 1e9) return (value / 1e9).toFixed(1).replace(/\.0$/, '') + 'B';
  if (value >= 1e6) return (value / 1e6).toFixed(value >= 1e7 ? 1 : 2).replace(/\.?0+$/, '') + 'M';
  if (value >= 1e4) return Math.round(value / 1e3) + 'k';
  return formatCount(value);
}

export function formatDuration(seconds) {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds)) return '—';
  const s = Math.max(0, Math.round(seconds));
  const days = Math.floor(s / 86400), hours = Math.floor(s % 86400 / 3600), minutes = Math.floor(s % 3600 / 60);
  if (days) return `${days}d ${hours}h`;
  if (hours) return `${hours}h ${minutes}m`;
  if (minutes) return `${minutes}m ${s % 60}s`;
  return `${s}s`;
}

// "3 hours ago", "in 2 days", or "just now".
export function timeAgo(value, now = Date.now()) {
  if (!value) return '—';
  const diff = (now - new Date(value).getTime()) / 1000;
  if (!Number.isFinite(diff)) return '—';
  const future = diff < 0, s = Math.abs(diff);
  if (s < 45) return future ? 'in a moment' : 'just now';
  const [amount, unit] = s < 3600 ? [Math.round(s / 60), 'minute'] : s < 86400 ? [Math.round(s / 3600), 'hour'] : s < 86400 * 45 ? [Math.round(s / 86400), 'day'] : [Math.round(s / 86400 / 30), 'month'];
  const text = `${amount} ${unit}${amount === 1 ? '' : 's'}`;
  return future ? `in ${text}` : `${text} ago`;
}

export const formatDate = (value, options = { year: 'numeric', month: 'short', day: 'numeric' }) => value ? new Date(value).toLocaleDateString('en-US', options) : '—';
export const formatDateTime = value => value ? new Date(value).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '—';
export const share = (part, whole) => whole ? Math.min(1, Math.max(0, part / whole)) : 0;

// Plain-language checks shown at the top: [{ id, level: 'ok'|'warning'|'error', label, detail }].
export function healthChecks(overview, now = Date.now()) {
  const checks = [];
  const day = 86400000;
  const refresh = overview.jobs?.refresh;
  if (refresh) checks.push(refresh.running ? { id: 'refresh', level: 'ok', label: 'Nightly refresh running', detail: refresh.step || 'In progress' }
    : refresh.outcome === 'failed' ? { id: 'refresh', level: 'error', label: 'Last refresh failed', detail: refresh.error || 'See Site data' }
      : { id: 'refresh', level: now - new Date(refresh.finishedAt) > 2 * day ? 'warning' : 'ok', label: 'Refresh', detail: `Finished ${timeAgo(refresh.finishedAt, now)}` });
  const imports = overview.jobs?.imports?.latest;
  if (imports) checks.push(imports.status === 'failed' || imports.error ? { id: 'imports', level: 'error', label: 'Last automatic import failed', detail: imports.error || '' }
    : { id: 'imports', level: now - new Date(imports.startedAt) > 3 * day ? 'warning' : 'ok', label: 'Automatic imports', detail: `Checked ${timeAgo(imports.startedAt, now)}` });
  const backup = overview.jobs?.backup;
  if (!backup) checks.push({ id: 'backup', level: 'warning', label: 'Backups', detail: 'No backup has reported here yet' });
  else if (backup.state === 'failed') checks.push({ id: 'backup', level: 'error', label: 'Last backup failed', detail: backup.error || '' });
  else if (backup.state === 'running') checks.push({ id: 'backup', level: 'ok', label: 'Backup running', detail: `Started ${timeAgo(backup.startedAt, now)}` });
  else checks.push({ id: 'backup', level: backup.lastSuccess && now - new Date(backup.lastSuccess.completedAt) < 40 * day ? 'ok' : 'warning', label: 'Backups',
    detail: backup.lastSuccess ? `Verified ${timeAgo(backup.lastSuccess.completedAt, now)}` : 'No verified backup yet' });
  const cache = overview.database?.cache;
  if (cache) {
    const used = share(cache.used, cache.max);
    checks.push({ id: 'cache', level: used > 0.95 ? 'warning' : 'ok', label: 'Database memory', detail: `${Math.round(used * 100)}% of cache in use` });
  }
  const container = overview.server?.container;
  if (container?.limit) {
    const used = share(container.used, container.limit);
    checks.push({ id: 'server', level: used > 0.85 ? 'warning' : 'ok', label: 'Web server memory', detail: `${Math.round(used * 100)}% of its limit` });
  }
  const admins = overview.security?.admins;
  if (admins?.length) {
    const without = admins.filter(admin => !admin.twoFactor).map(admin => admin.username);
    checks.push(without.length ? { id: 'two-factor', level: 'warning', label: 'Two-factor sign-in', detail: `Off for ${without.join(', ')}` }
      : { id: 'two-factor', level: 'ok', label: 'Two-factor sign-in', detail: 'On for every administrator' });
  }
  const failed = overview.security?.failedSignIns24h || 0;
  checks.push({ id: 'security', level: overview.security?.blockedAddresses ? 'warning' : failed >= 10 ? 'warning' : 'ok', label: 'Sign-ins',
    detail: `${failed} failed in 24 hours${overview.security?.blockedAddresses ? ` · ${overview.security.blockedAddresses} blocked` : ''}` });
  return checks;
}

export const overallLevel = checks => checks.some(check => check.level === 'error') ? 'error' : checks.some(check => check.level === 'warning') ? 'warning' : 'ok';

// Labels for the activity timeline. Account and sign-in events share the
// Access & security tab's wording; uploads and data clears are described here.
const DATA_EVENTS = { upload: 'Manual upload', 'data-cleared': 'Data cleared' };
export function describeActivity(item) {
  if (item.kind === 'import') {
    const imported = item.outcomes?.imported || 0, errors = item.outcomes?.error || 0, review = item.outcomes?.['source-review-required'] || 0;
    return { tone: item.error || item.status === 'failed' || errors ? 'error' : review ? 'warning' : 'ok', title: item.mode === 'backfill' ? 'Automatic import (backfill)' : 'Automatic import',
      detail: item.error || [imported ? `${imported} imported` : null, errors ? `${errors} failed` : null, review ? `${review} need review` : null,
        `${item.files} release${item.files === 1 ? '' : 's'} checked`].filter(Boolean).join(' · ') };
  }
  if (item.kind === 'refresh') return { tone: item.outcome === 'failed' ? 'error' : 'ok', title: 'Background refresh',
    detail: item.error || (item.steps?.length ? item.steps.join(', ') : item.outcome || '') };
  if (!DATA_EVENTS[item.type]) {
    const { label, tone, detail } = describeSecurityEvent(item);
    return { tone, title: label, detail };
  }
  const detail = item.type === 'upload' ? `${item.username} · ${String(item.program || '').toUpperCase()} · ${item.filename}`
    : `${item.username} · ${String(item.program || '').toUpperCase()} · ${formatCount(item.records)} records`;
  const tone = item.type === 'data-cleared' ? 'warning' : 'ok';
  return { tone, title: DATA_EVENTS[item.type], detail };
}

// Folds back-to-back entries that read the same (an hourly import that found nothing new,
// repeated failed sign-ins from one address) into one line with a count. Items are newest first.
export function groupActivity(items) {
  const groups = [];
  for (const item of items) {
    const described = describeActivity(item);
    const key = [item.kind, described.tone, described.title, described.detail, item.kind === 'admin' ? `${item.ip}|${item.userAgent}` : ''].join('\u0000');
    const last = groups.at(-1);
    if (last?.key === key) { last.count++; last.oldest = item.at; continue; }
    groups.push({ key, item, ...described, count: 1, newest: item.at, oldest: item.at });
  }
  return groups;
}
