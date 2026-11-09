import { programs } from './programs.js';

export const MAP_PROGRAMS = ['h1b', 'perm', 'pwd'];
export const CLASS_COUNT = 5;
// Rankings by a rate, median or share ignore places with few filings, where
// one employer can dominate the value.
export const RANK_MINIMUM = { states: 25, metros: 50 };

export const wageNoun = program => program === 'pwd' ? 'prevailing wage' : 'offered wage';

export function mapMetrics(program) {
  return {
    count: { label: 'Filings', short: 'Filings', description: 'Number of filings with this worksite.' },
    perCapita: { label: 'Filings per 100k residents', short: 'Per 100k residents', description: 'Filings per 100,000 residents (Census 2023 population estimates). Adjusts for population size.' },
    median: { label: `Median annual ${wageNoun(program)}`, short: 'Median wage', description: `Median ${wageNoun(program)}${program === 'pwd' ? '' : ' (lower end of the reported range)'}, converted to a yearly amount: hourly × 2,080, weekly × 52, biweekly × 26, monthly × 12. Shown for places with at least 10 reported wages.` },
    senior: { label: 'Share at wage Level III or IV', short: 'Level III–IV share', description: 'Share of filings whose prevailing wage level is III or IV (experienced roles), among filings that report a level. Shown for places with at least 10.' },
  };
}

const money = value => '$' + Math.round(value).toLocaleString('en-US');
export function formatMetric(metric, value) {
  if (value === null || value === undefined || Number.isNaN(value)) return 'Not enough data';
  if (metric === 'count') return Math.round(value).toLocaleString('en-US');
  if (metric === 'perCapita') return value >= 10 ? Math.round(value).toLocaleString('en-US') : value.toFixed(1);
  if (metric === 'median') return money(value);
  if (metric === 'senior') return Math.round(value * 100) + '%';
  return String(value);
}
export function formatCompact(metric, value) {
  if (metric === 'median') return value >= 1000 ? '$' + Math.round(value / 1000) + 'k' : money(value);
  if (metric === 'count' && value >= 10000) return Math.round(value / 1000).toLocaleString('en-US') + 'k';
  return formatMetric(metric, value);
}

// Quantile class breaks: each of up to five classes holds a similar number of
// places, so a few very large states do not wash out the rest of the map.
export function classBreaks(values) {
  const sorted = values.filter(value => value !== null && value !== undefined && Number.isFinite(value)).sort((a, b) => a - b);
  if (!sorted.length) return [];
  const breaks = [];
  for (let index = 1; index < CLASS_COUNT; index++) {
    const value = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * index / CLASS_COUNT))];
    if (value > sorted[0] && !breaks.includes(value)) breaks.push(value);
  }
  return [sorted[0], ...breaks, sorted.at(-1)];
}
// Class 1…n for a value given breaks [min, b1, …, max]; 0 means no data.
export function classOf(value, breaks) {
  if (value === null || value === undefined || !breaks.length) return 0;
  let index = 1;
  while (index < breaks.length - 1 && value >= breaks[index]) index++;
  return index;
}
// Spread the classes in use across the full five-step ramp.
export function rampStep(index, breaks) {
  const classes = Math.max(1, breaks.length - 1);
  return classes === 1 ? 3 : 1 + Math.round((index - 1) * (CLASS_COUNT - 1) / (classes - 1));
}
export function legendEntries(metric, breaks) {
  const entries = [];
  for (let index = 1; index < breaks.length; index++) {
    const low = breaks[index - 1], high = breaks[index];
    entries.push({ step: rampStep(index, breaks), label: low === high ? formatCompact(metric, low) : `${formatCompact(metric, low)}–${formatCompact(metric, high)}` });
  }
  return entries;
}

// Bubble area is proportional to filings.
export const bubbleRadius = (count, max, largest = 28) => max > 0 ? Math.max(2.2, Math.sqrt(count / max) * largest) : 0;

// "Seattle-Tacoma-Bellevue, WA" → "Seattle".
export const principalCity = name => String(name).split(',')[0].split('-')[0].split('/')[0].trim();

// Case search for a place: a state, or a metro's principal city within its state.
export function placeSearchURL(program, place, { year, employer } = {}) {
  const config = programs[program];
  const params = new URLSearchParams();
  if (employer) {
    if (employer.groupId) { params.set('employerGroup', employer.groupId); params.set('company', employer.name); }
    else params.set('employer', employer.key);
  }
  if (place.kind === 'metro') { params.set('worksiteState', place.state); params.set('worksite', principalCity(place.name)); }
  else params.set('worksiteState', place.code);
  if (year && year !== 'all') params.set(config.yearKey, String(year));
  return (program === 'pwd' ? '/' : '/' + program) + '?' + params;
}

export function readMapState(params) {
  const program = MAP_PROGRAMS.includes(params.get('program')) ? params.get('program') : 'h1b';
  const year = /^(?:19|20)\d{2}$/.test(params.get('year') || '') ? params.get('year') : 'all';
  const occupation = /^\d{2}-\d{4}$/.test(params.get('occupation') || '') ? params.get('occupation') : 'all';
  const metric = ['count', 'perCapita', 'median', 'senior'].includes(params.get('metric')) ? params.get('metric') : 'count';
  const view = params.get('view') === 'metros' ? 'metros' : 'states';
  return { program, year, occupation, metric, view };
}
export function writeMapState(state) {
  const params = new URLSearchParams();
  if (state.program !== 'h1b') params.set('program', state.program);
  if (state.year !== 'all') params.set('year', state.year);
  if (state.occupation !== 'all') params.set('occupation', state.occupation);
  if (state.metric !== 'count') params.set('metric', state.metric);
  if (state.view !== 'states') params.set('view', state.view);
  return params;
}

// Places ranked by a metric, largest first; rates need enough filings.
export function rankPlaces(rows, metric, kind, limit = 15) {
  const minimum = metric === 'count' ? 1 : RANK_MINIMUM[kind];
  return rows.filter(row => row[metric] !== null && row[metric] !== undefined && row.count >= minimum)
    .sort((a, b) => b[metric] - a[metric] || b.count - a.count || a.name.localeCompare(b.name)).slice(0, limit);
}
