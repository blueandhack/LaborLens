import { programs } from './programs.js';

export const MAP_PROGRAMS = ['h1b', 'perm', 'pwd'];
export const CLASS_COUNT = 5;
// Rankings by a rate, median or share ignore places with few filings, where
// one employer can dominate the value.
export const RANK_MINIMUM = { states: 25, metros: 50, counties: 25, cities: 25 };

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

// Case search for a place: a state, a city, or a metro's principal city within its state.
// Counties have no case-search filter and search their state.
export function placeSearchURL(program, place, { year, employer } = {}) {
  const config = programs[program];
  const params = new URLSearchParams();
  if (employer) {
    if (employer.groupId) { params.set('employerGroup', employer.groupId); params.set('company', employer.name); }
    else params.set('employer', employer.key);
  }
  if (place.kind === 'metro') { params.set('worksiteState', place.state); params.set('worksite', principalCity(place.name)); }
  else if (place.kind === 'city') { params.set('worksiteState', place.state); params.set('worksite', place.name); }
  else params.set('worksiteState', place.kind === 'county' ? place.state : place.code);
  if (year && year !== 'all') params.set(config.yearKey, String(year));
  return (program === 'pwd' ? '/' : '/' + program) + '?' + params;
}

export function readMapState(params) {
  const program = MAP_PROGRAMS.includes(params.get('program')) ? params.get('program') : 'h1b';
  const year = /^(?:19|20)\d{2}$/.test(params.get('year') || '') ? params.get('year') : 'all';
  const occupation = /^\d{2}-\d{4}$/.test(params.get('occupation') || '') ? params.get('occupation') : 'all';
  const metric = ['count', 'perCapita', 'median', 'senior'].includes(params.get('metric')) ? params.get('metric') : 'count';
  const view = params.get('view') === 'metros' ? 'metros' : 'states';
  // Zoomed place: a state, then optionally one of its counties and cities.
  const state = /^[A-Z]{2}$/.test(params.get('state') || '') ? params.get('state') : '';
  const county = state && /^\d{5}$/.test(params.get('county') || '') ? params.get('county') : '';
  const city = state ? (params.get('city') || '').trim().toLowerCase().slice(0, 80) : '';
  return { program, year, occupation, metric, view, state, county, city };
}
export function writeMapState(state) {
  const params = new URLSearchParams();
  if (state.program !== 'h1b') params.set('program', state.program);
  if (state.year !== 'all') params.set('year', state.year);
  if (state.occupation !== 'all') params.set('occupation', state.occupation);
  if (state.metric !== 'count') params.set('metric', state.metric);
  if (state.view !== 'states') params.set('view', state.view);
  if (state.state) params.set('state', state.state);
  if (state.state && state.county) params.set('county', state.county);
  if (state.state && state.city) params.set('city', state.city);
  return params;
}

// --- Zooming ---
export const MAP_WIDTH = 975, MAP_HEIGHT = 610;
export const FULL_VIEW = [0, 0, MAP_WIDTH, MAP_HEIGHT];

// A viewBox [x, y, width, height] showing box [x0, y0, x1, y1] with padding,
// at the map's aspect ratio and no smaller than minimum map units across
// (one unit is about 4.6 km in the contiguous states).
export function fitBox([x0, y0, x1, y1], { padding = 0.08, minimum = 4 } = {}) {
  let width = Math.max(x1 - x0, minimum) * (1 + padding * 2), height = Math.max(y1 - y0, minimum * MAP_HEIGHT / MAP_WIDTH) * (1 + padding * 2);
  if (width / height > MAP_WIDTH / MAP_HEIGHT) height = width * MAP_HEIGHT / MAP_WIDTH; else width = height * MAP_WIDTH / MAP_HEIGHT;
  const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
  return [cx - width / 2, cy - height / 2, width, height];
}
export const boundsOf = points => {
  const xs = points.map(point => point[0]), ys = points.map(point => point[1]);
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
};

// Smooth zoom between two viewBoxes (van Wijk and Nuij, "Smooth and efficient
// zooming and panning"): returns t ∈ [0, 1] → viewBox and a duration in ms.
export function zoomPath(from, to, rho = Math.SQRT2) {
  const [ux0, uy0, w0] = [from[0] + from[2] / 2, from[1] + from[3] / 2, from[2]];
  const [ux1, uy1, w1] = [to[0] + to[2] / 2, to[1] + to[3] / 2, to[2]];
  const dx = ux1 - ux0, dy = uy1 - uy0, d2 = dx * dx + dy * dy, ratio = MAP_HEIGHT / MAP_WIDTH;
  const box = (x, y, w) => [x - w / 2, y - w * ratio / 2, w, w * ratio];
  let S, at;
  if (d2 < 1e-12) {
    S = Math.log(w1 / w0) / rho;
    at = t => box(ux0, uy0, w0 * Math.exp(rho * t * S));
  } else {
    const d1 = Math.sqrt(d2), b0 = (w1 * w1 - w0 * w0 + rho ** 4 * d2) / (2 * w0 * rho * rho * d1), b1 = (w1 * w1 - w0 * w0 - rho ** 4 * d2) / (2 * w1 * rho * rho * d1);
    const r0 = Math.log(Math.sqrt(b0 * b0 + 1) - b0), r1 = Math.log(Math.sqrt(b1 * b1 + 1) - b1);
    S = (r1 - r0) / rho;
    at = t => {
      const s = t * S, coshr0 = Math.cosh(r0), u = w0 / (rho * rho * d1) * (coshr0 * Math.tanh(rho * s + r0) - Math.sinh(r0));
      return box(ux0 + u * dx, uy0 + u * dy, w0 * coshr0 / Math.cosh(rho * s + r0));
    };
  }
  return { at: t => t >= 1 ? to : at(t), duration: Math.min(1400, Math.max(450, Math.abs(S) * 420)) };
}

// Labels for the largest places that fit without overlapping, in map units:
// font is the label size in map units; places are sorted largest first.
export function placeLabels(places, { font, limit = 12, gap = 0.3 } = {}) {
  const placed = [];
  for (const place of places) {
    if (placed.length >= limit) break;
    const width = place.label.length * font * 0.56, x = place.x + place.r + font * 0.35, y = place.y + font * 0.35;
    const box = [x - gap * font, y - font - gap * font, x + width + gap * font, y + gap * font];
    if (placed.some(other => box[0] < other.box[2] && box[2] > other.box[0] && box[1] < other.box[3] && box[3] > other.box[1])) continue;
    placed.push({ ...place, lx: x, ly: y, box });
  }
  return placed;
}

// Places ranked by a metric, largest first; rates need enough filings.
export function rankPlaces(rows, metric, kind, limit = 15) {
  const minimum = metric === 'count' ? 1 : RANK_MINIMUM[kind];
  return rows.filter(row => row[metric] !== null && row[metric] !== undefined && row.count >= minimum)
    .sort((a, b) => b[metric] - a[metric] || b.count - a.count || a.name.localeCompare(b.name)).slice(0, limit);
}

// --- Free panning and zooming ---
// Widest view (a little beyond the whole country) and closest (about 5 km across).
export const MAX_VIEW_WIDTH = MAP_WIDTH * 1.15, MIN_VIEW_WIDTH = 1.2;
// Keeps a viewBox within the zoom limits and its center over the map.
export function clampBox([x, y, width]) {
  const w = Math.min(MAX_VIEW_WIDTH, Math.max(MIN_VIEW_WIDTH, width)), h = w * MAP_HEIGHT / MAP_WIDTH;
  const cx = Math.min(MAP_WIDTH + 40, Math.max(-40, x + width / 2)), cy = Math.min(MAP_HEIGHT + 30, Math.max(-30, y + width * MAP_HEIGHT / MAP_WIDTH / 2));
  return [cx - w / 2, cy - h / 2, w, h];
}
// Zooms by factor (> 1 zooms in) keeping map point [px, py] in place.
export function zoomBoxAt(box, [px, py], factor) {
  const next = clampBox([0, 0, box[2] / factor]), scale = next[2] / box[2];
  return clampBox([px - (px - box[0]) * scale, py - (py - box[1]) * scale, next[2]]);
}
// Moves the view by dx, dy map units.
export const panBox = (box, dx, dy) => clampBox([box[0] - dx, box[1] - dy, box[2]]);
