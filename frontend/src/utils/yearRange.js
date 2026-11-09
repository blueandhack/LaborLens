// A fiscal-year range within the years a dataset has. Missing ends mean the
// first or last year; reversed ends are swapped.
export function normalizeRange(years, from, to) {
  if (!years.length) return { from: null, to: null, whole: true, single: false };
  const first = years[0], last = years.at(-1);
  const clamp = value => {
    const number = Number(value);
    return value === '' || value === null || value === undefined || !Number.isInteger(number) ? null : Math.min(last, Math.max(first, number));
  };
  let start = clamp(from) ?? first, end = clamp(to) ?? last;
  if (start > end) [start, end] = [end, start];
  return { from: start, to: end, whole: start === first && end === last, single: start === end };
}

// URL values for a range: an end at the dataset's bound is left out.
export function rangeParams(years, from, to) {
  const range = normalizeRange(years, from, to);
  return { from: range.from === years[0] ? '' : String(range.from), to: range.to === years.at(-1) ? '' : String(range.to) };
}

export const inRange = (year, range) => year >= range.from && year <= range.to;
export const yearParam = value => /^\d{4}$/.test(value || '') ? value : '';
