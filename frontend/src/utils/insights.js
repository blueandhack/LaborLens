// Missing calendar years mean no matching imported records, not zero filings.
export function calendarSeries(timeline) {
  if (!timeline.length) return [];
  const counts = new Map(timeline.map(({ year, count }) => [year, count]));
  const first = Math.min(...counts.keys());
  const last = Math.max(...counts.keys());
  return Array.from({ length: last - first + 1 }, (_, i) => ({
    year: first + i, count: counts.get(first + i) || 0,
  }));
}

// Fifty equal-width slots form 100%. A partial tick uses proportional width.
export function outcomeTicks(count, total) {
  if (!total || !count) return [];
  const slots = Math.min(50, Math.max(0, count / total * 50));
  return Array.from({ length: Math.ceil(slots) }, (_, i) => Math.min(1, slots - i));
}

export function statusLabel(status) {
  return status.toLowerCase().replace(/(^|[\s-])\S/g, (letter) => letter.toUpperCase());
}
