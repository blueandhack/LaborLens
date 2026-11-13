// USCIS H-1B Employer Data Hub: page state, rates and chart scales.
export const USCIS_PATH = '/h1b-approvals';
export const USCIS_SORTS = {
  approvals: 'Most approvals',
  initial: 'Most initial approvals',
  denials: 'Most denials',
  denialRate: 'Highest denial rate',
  name: 'Name (A–Z)',
};
export const USCIS_STATE_KEYS = ['from', 'to', 'fy', 'state', 'industry', 'q', 'sort', 'page', 'by', 'industries', 'states', 'employers', 'metric'];
// What the compare section lists and charts, and the measures it charts.
export const COMPARE_BY = [{ key: 'industry', label: 'Industries' }, { key: 'state', label: 'States' }, { key: 'employer', label: 'Petitioners' }];
export const USCIS_METRICS = [
  { key: 'approvals', label: 'Approvals', title: 'Workers approved each year' },
  { key: 'initialApprovals', label: 'Initial approvals', title: 'Initial petitions approved each year' },
  { key: 'rate', label: 'Denial rate', title: 'Denial rate each year', rate: true },
  { key: 'initialRate', label: 'Initial denial rate', title: 'Initial denial rate each year', rate: true },
];
// Short industry names for chart labels.
export const INDUSTRY_SHORT = { 11: 'Agriculture', 21: 'Mining', 22: 'Utilities', 23: 'Construction', '31-33': 'Manufacturing', 42: 'Wholesale', '44-45': 'Retail',
  '48-49': 'Transportation', 51: 'Information', 52: 'Finance', 53: 'Real estate', 54: 'Professional', 55: 'Management', 56: 'Admin. support', 61: 'Education',
  62: 'Health care', 71: 'Arts', 72: 'Food & lodging', 81: 'Other services', 92: 'Public admin.', 99: 'Unknown' };
// The parts of the address a visitor can keep as their view (not the years, search or page).
export const VIEW_KEYS = ['state', 'industry', 'by', 'industries', 'states', 'employers', 'metric'];
const MAX_COMPARE = 4;
const listOf = (value, valid) => [...new Set(String(value || '').split(',').map(item => item.trim()).filter(item => item && valid(item)))].slice(0, MAX_COMPARE);
export const SERIES = [
  { key: 'initial', label: 'Initial', description: 'New employment and new concurrent employment' },
  { key: 'continuing', label: 'Continuing', description: 'Continuation, change of employer, change with the same employer and amended petitions' },
];

export function readUscisState(params) {
  const page = Number(params.get('page'));
  const year = key => /^\d{4}$/.test(params.get(key) || '') ? params.get(key) : '';
  // fy (a single year) is the earlier link format.
  return {
    from: year('fy') || year('from'),
    to: year('fy') || year('to'),
    state: /^[A-Z]{2}$/.test(params.get('state') || '') ? params.get('state') : '',
    industry: /^\d{2}(-\d{2})?$/.test(params.get('industry') || '') ? params.get('industry') : '',
    q: (params.get('q') || '').slice(0, 160),
    sort: USCIS_SORTS[params.get('sort')] ? params.get('sort') : 'approvals',
    page: Number.isSafeInteger(page) && page > 1 ? page : 1,
    by: COMPARE_BY.some(item => item.key === params.get('by')) ? params.get('by') : 'industry',
    industries: listOf(params.get('industries'), code => /^\d{2}(-\d{2})?$/.test(code)),
    states: listOf(params.get('states'), code => /^[A-Z]{2}$/.test(code)),
    employers: listOf(params.get('employers'), key => key.length <= 200),
    metric: USCIS_METRICS.some(item => item.key === params.get('metric')) ? params.get('metric') : 'approvals',
  };
}

// Only non-default values go in the URL; any filter change returns to page 1.
export function writeUscisState(state) {
  const params = new URLSearchParams();
  if (state.from) params.set('from', state.from);
  if (state.to) params.set('to', state.to);
  if (state.state) params.set('state', state.state);
  if (state.industry) params.set('industry', state.industry);
  if (state.q?.trim()) params.set('q', state.q.trim());
  if (state.sort && state.sort !== 'approvals') params.set('sort', state.sort);
  if (state.page > 1) params.set('page', String(state.page));
  if (state.by && state.by !== 'industry') params.set('by', state.by);
  for (const key of ['industries', 'states', 'employers']) if (state[key]?.length) params.set(key, state[key].join(','));
  if (state.metric && state.metric !== 'approvals') params.set('metric', state.metric);
  return params;
}

// The kept view as an address query: only VIEW_KEYS, in a fixed order.
export function viewOf(state) {
  const all = writeUscisState(state), view = new URLSearchParams();
  for (const key of VIEW_KEYS) if (all.has(key)) view.set(key, all.get(key));
  return view.toString();
}

// The years a selection totals: one year on its own, or the range without partial years.
export function countedYears(years, from, to) {
  const shown = years.filter(year => year.fiscalYear >= from && year.fiscalYear <= to);
  return (from === to ? shown : shown.filter(year => !year.partial)).map(year => year.fiscalYear);
}
// The same number of complete years just before, or null when there are not enough.
export function priorYears(years, counted) {
  if (!counted.length) return null;
  const before = years.filter(year => year.fiscalYear < counted[0] && !year.partial).map(year => year.fiscalYear);
  return before.length >= counted.length ? before.slice(-counted.length) : null;
}

const FIELDS = ['initialApprovals', 'initialDenials', 'continuingApprovals', 'continuingDenials'];
// Rates need enough decisions to mean something, as in the petitioner rankings.
export const MIN_RATE_DECISIONS = 20;
export function measures(totals) {
  const approvals = totals.initialApprovals + totals.continuingApprovals, denials = totals.initialDenials + totals.continuingDenials;
  const initialDecisions = totals.initialApprovals + totals.initialDenials, continuingDecisions = totals.continuingApprovals + totals.continuingDenials;
  return { ...totals, approvals, denials,
    rate: approvals + denials >= MIN_RATE_DECISIONS ? denials / (approvals + denials) : null,
    initialRate: initialDecisions >= MIN_RATE_DECISIONS ? totals.initialDenials / initialDecisions : null,
    continuingRate: continuingDecisions >= MIN_RATE_DECISIONS ? totals.continuingDenials / continuingDecisions : null };
}
// Yearly rows ({ fiscalYear, initialApprovals, … }) summed over some years.
export function sumYears(rows, years) {
  const wanted = new Set(years), totals = Object.fromEntries(FIELDS.map(field => [field, 0]));
  for (const row of rows) if (wanted.has(row.fiscalYear)) for (const field of FIELDS) totals[field] += row[field] || 0;
  return measures(totals);
}
// One group (an industry, state or petitioner) for the counted years, with the change in approvals from the years before.
export function groupSummary(rows, counted, prior) {
  const now = sumYears(rows, counted), before = prior ? sumYears(rows, prior) : null;
  return { ...now, change: before?.approvals ? now.approvals / before.approvals - 1 : null };
}

export const apiQuery = (state, keys) => new URLSearchParams(keys.flatMap(key => {
  const value = state[key];
  return value && value !== 'all' && !(key === 'sort' && value === 'approvals') && !(key === 'page' && value === 1) ? [[key, String(value)]] : [];
})).toString();

export const totalsOf = row => ({
  approvals: row.initialApprovals + row.continuingApprovals,
  denials: row.initialDenials + row.continuingDenials,
});
export const rate = (denials, approvals) => approvals + denials > 0 ? denials / (approvals + denials) : null;
export const seriesValues = row => ({
  initial: { approvals: row.initialApprovals, denials: row.initialDenials, rate: rate(row.initialDenials, row.initialApprovals) },
  continuing: { approvals: row.continuingApprovals, denials: row.continuingDenials, rate: rate(row.continuingDenials, row.continuingApprovals) },
});

export const formatCount = value => Number.isFinite(value) ? value.toLocaleString('en-US') : '—';
export const formatRate = value => value === null || value === undefined || !Number.isFinite(value) ? '—'
  : `${(Math.round(value * 1000) / 10).toLocaleString('en-US', { minimumFractionDigits: value < 0.1 ? 1 : 0, maximumFractionDigits: 1 })}%`;
export const compact = value => Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 }).format(value);
export const fyLabel = year => `FY${year}`;

// A rounded axis maximum and ticks (0, half, max) for a zero-based scale.
export function niceMax(value) {
  if (!(value > 0)) return 1;
  const power = 10 ** Math.floor(Math.log10(value));
  const step = [1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10].find(candidate => candidate * power >= value);
  return step * power;
}

export const location = value => [value?.city, value?.state].filter(Boolean).map(part => part.length > 2 ? titleCase(part) : part).join(', ');
export const titleCase = value => String(value || '').toLowerCase().replace(/\b([a-z])/g, letter => letter.toUpperCase()).replace(/\b(Llc|Inc|Ltd|Usa|Us|Lp|Llp|Pc|Pllc)\b/g, word => word.toUpperCase());

// The years a selection covers, for headings: "FY2009–FY2022".
export function coverageLabel(years, { excludePartial = false } = {}) {
  const shown = years.filter(year => !excludePartial || !year.partial).map(year => year.fiscalYear);
  if (!shown.length) return '';
  return shown.length === 1 ? fyLabel(shown[0]) : `${fyLabel(Math.min(...shown))}–${fyLabel(Math.max(...shown))}`;
}

// The page's two requests, shared with link prefetching so the URLs match exactly.
export const uscisOverviewURL = state => '/api/uscis-h1b?' + apiQuery(state, ['from', 'to', 'state', 'industry']);
export const uscisBreakdownURL = state => `/api/uscis-h1b/breakdown?by=${state.by}` + (state.by === 'industry' && state.state ? `&state=${state.state}` : state.by === 'state' && state.industry ? `&industry=${encodeURIComponent(state.industry)}` : '');
export const uscisCompareURL = keys => '/api/uscis-h1b/compare?' + new URLSearchParams({ employers: keys.join(',') });
export const uscisEmployersURL = state => '/api/uscis-h1b/employers?' + apiQuery(state, ['from', 'to', 'state', 'industry', 'q', 'sort', 'page']);
