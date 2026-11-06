export function formatDisclosureDate(value, locale) {
    if (!(value instanceof Date) && (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}(?:T|$)/.test(value))) return 'N/A';
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? 'N/A' : date.toLocaleDateString(locale, { timeZone: 'UTC' });
}
