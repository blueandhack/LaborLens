import { programLabel } from './importPresentation.js';

const count = value => Number.isFinite(value) ? value.toLocaleString('en-US') : '—';

export function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '—';
  const minutes = Math.round(ms / 60000);
  if (minutes < 1) return 'under a minute';
  if (minutes < 60) return `${minutes} min`;
  return `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
}
export const elapsed = (from, to = new Date()) => from ? formatDuration(new Date(to) - new Date(from)) : '—';
export const percent = (part, whole) => whole ? `${Math.round(part / whole * 1000) / 10}%` : '—';

// The nightly refresh run (refresh-employers.js).
export function refreshState(refresh) {
  if (!refresh) return { label: 'No run recorded yet', tone: 'neutral' };
  if (refresh.interrupted) return { label: 'Interrupted', tone: 'error' };
  if (refresh.running) return { label: 'Running', tone: 'active' };
  if (refresh.outcome === 'failed') return { label: 'Last run failed', tone: 'error' };
  return { label: 'Last run succeeded', tone: 'success' };
}

// One map program: build progress, or the last completed build.
export function mapState(row) {
  const build = row.build;
  if (build?.state === 'building') return build.interrupted ? { label: 'Interrupted', tone: 'error', detail: `Stopped during: ${build.phase || 'build'}` }
    : { label: 'Building', tone: 'active', detail: [build.phase, build.of ? `${count(build.completed)} of ${count(build.of)} occupations` : null].filter(Boolean).join(' · ') };
  if (build?.state === 'failed') return { label: 'Failed', tone: 'error', detail: build.error || 'The last build failed.' };
  if (!row.built) return { label: 'Not built', tone: 'warning', detail: 'Builds at the next nightly refresh.' };
  if (!row.upToDate) return { label: 'Out of date', tone: 'warning', detail: 'Cases changed since this build. Rebuilds at the next nightly refresh.' };
  return { label: 'Current', tone: 'success', detail: build?.state === 'unchanged' ? 'Cases unchanged at the last check.' : 'Built from the current cases.' };
}

// A human-readable line for the refresh job's latest progress event.
export function describeEvent(event) {
  if (!event?.event) return null;
  const program = event.program ? programLabel(event.program) + ': ' : '';
  switch (event.event) {
    case 'worksites': return `Worksite fields · ${program}${count(event.processed)} cases`;
    case 'worksites-ready': return `Worksite fields · ${program}done`;
    case 'index': return `Building index ${event.index}`;
    case 'directory': return `Employer directory · ${program}${count(event.employers)} names`;
    case 'identities': return `Employer identities · ${count(event.identities)} identities, ${count(event.combined)} combined`;
    case 'identities-ready': return `Employer identities · done (${count(event.identities)})`;
    case 'map-cells': return `Worksite map · ${program}${count(event.cells)} cells`;
    case 'map-occupations': return `Worksite map · ${program}${count(event.completed)} of ${count(event.of)} occupations`;
    case 'map-ready': return `Worksite map · ${program}done (${count(event.total)} filings)`;
    case 'map-unchanged': return `Worksite map · ${program}unchanged`;
    case 'profile': return `Featured profiles · ${count(event.completed)} done (latest: ${event.employer})`;
    case 'profile-failed': return `Featured profile failed: ${event.employer}`;
    default: return event.event.replaceAll('-', ' ');
  }
}
