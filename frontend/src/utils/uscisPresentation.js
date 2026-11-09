// USCIS H-1B Employer Data Hub: page state, rates and chart scales.
export const USCIS_PATH = '/h1b-approvals';
export const USCIS_SORTS = {
  approvals: 'Most approvals',
  initial: 'Most initial approvals',
  denials: 'Most denials',
  denialRate: 'Highest denial rate',
  name: 'Name (A–Z)',
};
export const USCIS_STATE_KEYS = ['fy', 'state', 'industry', 'q', 'sort', 'page'];
export const SERIES = [
  { key: 'initial', label: 'Initial', description: 'New employment and new concurrent employment' },
  { key: 'continuing', label: 'Continuing', description: 'Continuation, change of employer, change with the same employer and amended petitions' },
];

export function readUscisState(params) {
  const page = Number(params.get('page'));
  return {
    fy: /^\d{4}$/.test(params.get('fy') || '') ? params.get('fy') : 'all',
    state: /^[A-Z]{2}$/.test(params.get('state') || '') ? params.get('state') : '',
    industry: /^\d{2}(-\d{2})?$/.test(params.get('industry') || '') ? params.get('industry') : '',
    q: (params.get('q') || '').slice(0, 160),
    sort: USCIS_SORTS[params.get('sort')] ? params.get('sort') : 'approvals',
    page: Number.isSafeInteger(page) && page > 1 ? page : 1,
  };
}

// Only non-default values go in the URL; any filter change returns to page 1.
export function writeUscisState(state) {
  const params = new URLSearchParams();
  if (state.fy && state.fy !== 'all') params.set('fy', state.fy);
  if (state.state) params.set('state', state.state);
  if (state.industry) params.set('industry', state.industry);
  if (state.q?.trim()) params.set('q', state.q.trim());
  if (state.sort && state.sort !== 'approvals') params.set('sort', state.sort);
  if (state.page > 1) params.set('page', String(state.page));
  return params;
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
