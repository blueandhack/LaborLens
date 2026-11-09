// USCIS Form I-140 statistics: page state, labels and derived rates.
export const I140_PATH = '/i140';
export const I140_STATE_KEYS = ['category', 'country'];
const CATEGORY_CODES = ['all', 'eb1', 'eb1a', 'eb1b', 'eb1c', 'eb2', 'eb2a', 'niw', 'eb3', 'eb3s', 'eb3p', 'eb3u'];

export function readI140State(params) {
  return {
    category: CATEGORY_CODES.includes(params.get('category')) ? params.get('category') : 'all',
    country: (params.get('country') || '').slice(0, 60),
  };
}
export function writeI140State(state) {
  const params = new URLSearchParams();
  if (state.category && state.category !== 'all') params.set('category', state.category);
  if (state.country) params.set('country', state.country);
  return params;
}

// Denied share of decided petitions.
export const denialRate = (approved, denied) => approved + denied > 0 ? denied / (approved + denied) : null;

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
