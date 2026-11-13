// USCIS Form I-140 statistics: page state, labels and derived rates.
export const I140_PATH = '/i140';
export const I140_STATE_KEYS = ['category', 'country', 'from', 'to', 'compare', 'metric'];
export const CATEGORY_CODES = ['all', 'eb1', 'eb1a', 'eb1b', 'eb1c', 'eb2', 'eb2a', 'niw', 'eb3', 'eb3s', 'eb3p', 'eb3u'];
// Short names for chart labels, where the full USCIS names do not fit.
export const SHORT_LABELS = { all: 'All', eb1: 'EB-1', eb1a: 'EB-1A', eb1b: 'EB-1B', eb1c: 'EB-1C', eb2: 'EB-2', eb2a: 'EB-2 advanced', niw: 'NIW',
  eb3: 'EB-3', eb3s: 'EB-3 skilled', eb3p: 'EB-3 prof.', eb3u: 'EB-3 other' };

// Up to four categories side by side; each takes a fixed color slot by its position.
export const MAX_COMPARE = 4;
export const COMPARE_METRICS = [
  { key: 'received', label: 'Received', title: 'Petitions received each quarter' },
  { key: 'approved', label: 'Approved', title: 'Petitions approved each quarter' },
  { key: 'denied', label: 'Denied', title: 'Petitions denied each quarter' },
  { key: 'rate', label: 'Denial rate', title: 'Denial rate each quarter', rate: true },
  { key: 'pending', label: 'Pending', title: 'Petitions pending at quarter end' },
  { key: 'backlog', label: 'Backlog', title: 'Backlog in months of decisions', months: true },
];
const METRIC_KEYS = COMPARE_METRICS.map(metric => metric.key);

// Categories people usually weigh against each other, starting with the chosen one.
const SUGGESTED = { eb1a: ['eb1a', 'niw', 'eb1b'], eb1b: ['eb1b', 'eb1a', 'niw'], eb1c: ['eb1c', 'eb1a', 'eb2a'], eb2a: ['eb2a', 'niw', 'eb3p'],
  niw: ['niw', 'eb1a', 'eb2a'], eb3s: ['eb3s', 'eb3p', 'eb3u'], eb3p: ['eb3p', 'eb3s', 'eb2a'], eb3u: ['eb3u', 'eb3s', 'eb3p'] };
export const suggestedCompare = category => SUGGESTED[category] || ['eb1', 'eb2', 'eb3'];

function compareList(value) {
  if (value === null) return null;
  return [...new Set(value.split(',').filter(code => CATEGORY_CODES.includes(code)))].slice(0, MAX_COMPARE);
}

// compare is null while the page suggests the categories to compare.
export function readI140State(params, savedCategory = '') {
  const category = params.get('category');
  return {
    category: CATEGORY_CODES.includes(category) ? category : CATEGORY_CODES.includes(savedCategory) ? savedCategory : 'all',
    country: (params.get('country') || '').slice(0, 60),
    from: /^\d{4}$/.test(params.get('from') || '') ? params.get('from') : '',
    to: /^\d{4}$/.test(params.get('to') || '') ? params.get('to') : '',
    compare: compareList(params.get('compare')),
    metric: METRIC_KEYS.includes(params.get('metric')) ? params.get('metric') : 'received',
  };
}
// With a saved category, "All categories" is written out so it is not read back as the saved one.
export function writeI140State(state, savedCategory = '') {
  const params = new URLSearchParams();
  if (state.category && (state.category !== 'all' || savedCategory && savedCategory !== 'all')) params.set('category', state.category);
  if (state.country) params.set('country', state.country);
  if (state.from) params.set('from', state.from);
  if (state.to) params.set('to', state.to);
  if (state.compare?.length) params.set('compare', state.compare.join(','));
  if (state.metric && state.metric !== 'received') params.set('metric', state.metric);
  return params;
}

// The viewer's own category, kept in this browser only.
const SAVED_KEY = 'i140Category';
export function readSavedCategory() {
  try { const value = localStorage.getItem(SAVED_KEY); return CATEGORY_CODES.includes(value) ? value : ''; } catch { return ''; }
}
export function writeSavedCategory(value) {
  try { if (value) localStorage.setItem(SAVED_KEY, value); else localStorage.removeItem(SAVED_KEY); } catch { /* The page works without browser storage. */ }
}

// Denied share of decided petitions.
export const denialRate = (approved, denied) => approved + denied > 0 ? denied / (approved + denied) : null;

// How long the pending queue would take to clear at the recent pace: petitions
// pending at the end of a quarter ÷ the average decided per quarter over the
// four quarters ending there (at least two), in months.
export function backlogMonths(quarters, index, category) {
  const recent = quarters.slice(Math.max(0, index - 3), index + 1);
  if (recent.length < 2) return null;
  const decided = recent.reduce((sum, quarter) => sum + (quarter.categories[category]?.approved || 0) + (quarter.categories[category]?.denied || 0), 0) / recent.length;
  const pending = quarters[index]?.categories[category]?.pending;
  return decided > 0 && Number.isFinite(pending) ? pending / decided * 3 : null;
}
export const formatMonths = value => !Number.isFinite(value) ? '—' : value < 1 ? 'under a month' : `${Math.round(value)} ${Math.round(value) === 1 ? 'month' : 'months'}`;

// One category over a run of quarters (consecutive entries of allQuarters), with the
// change in receipts from the same number of quarters just before, when reported.
export function categorySummary(allQuarters, start, end, category) {
  const totals = (from, to) => allQuarters.slice(from, to + 1).reduce((sum, quarter) => {
    for (const key of ['received', 'approved', 'denied']) sum[key] += quarter.categories[category]?.[key] || 0;
    return sum;
  }, { received: 0, approved: 0, denied: 0 });
  const now = totals(start, end), length = end - start + 1;
  const before = start - length >= 0 ? totals(start - length, start - 1) : null;
  return { ...now, rate: denialRate(now.approved, now.denied), pending: allQuarters[end]?.categories[category]?.pending ?? null,
    backlog: backlogMonths(allQuarters, end, category), receivedChange: before?.received ? now.received / before.received - 1 : null,
    rateBefore: before ? denialRate(before.approved, before.denied) : null };
}

// Preference column(s) of the visa backlog table that hold a category's petitions.
export function awaitingColumns(labels, category, level) {
  const want = level === 'eb1' ? /^1st/ : level === 'eb2' ? /^2nd/ : category === 'eb3u' ? /^3rd \(other/i : category === 'eb3' ? /^3rd/ : level === 'eb3' ? /^3rd \(prof/i : null;
  return new Set(want ? labels.map((label, index) => want.test(label) ? index : -1).filter(index => index >= 0) : []);
}

// USCIS fiscal year N runs October N-1 through September N.
const MONTHS = ['Oct–Dec', 'Jan–Mar', 'Apr–Jun', 'Jul–Sep'];
export const quarterMonths = (fiscalYear, quarter) => `${MONTHS[quarter - 1]} ${quarter === 1 ? fiscalYear - 1 : fiscalYear}`;
export const quarterLabel = (fiscalYear, quarter) => `Q${quarter} FY${String(fiscalYear).slice(-2)}`;

// Filing-year outcomes are published for each preference level only.
export const levelOf = (categories, code) => categories.find(item => item.code === code)?.level || 'all';

// A filing year is still being decided while more than 10% of it is pending.
export const INCOMPLETE_SHARE = 0.1;

export const titleCase = value => String(value || '').toLowerCase().replace(/\b([a-z])/g, letter => letter.toUpperCase())
  .replace(/\b(Of|And|The)\b/g, word => word.toLowerCase()).replace(/^./, letter => letter.toUpperCase());
