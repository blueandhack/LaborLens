export const programLabel = type => type === 'h1b' ? 'H-1B' : (type || '').toUpperCase();
export const formatCount = value => Number.isFinite(value) ? value.toLocaleString() : '—';
export const formatImportDate = value => {
    const date = value ? new Date(value) : null;
    return date && !Number.isNaN(date.getTime()) ? date.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : 'Not recorded';
};
export const needsAttention = source => ['error', 'interrupted'].includes(source.status);
export const isProcessing = source => ['downloading', 'validating', 'importing'].includes(source.status);
export const sourceStatus = source => ({
    done: source.outcome === 'unchanged' ? 'Up to date' : 'Imported',
    error: 'Failed', interrupted: 'Interrupted', downloading: 'Downloading', validating: 'Validating', importing: 'Importing',
}[source.status] || source.status || 'Pending');

const reasons = { invalid_date: 'Invalid date', invalid_number: 'Invalid number', excel_error: 'Excel cell error', missing_case_number: 'Missing case number' };
export const issueLabel = reason => reasons[reason] || (reason || '').replaceAll('_', ' ');
export const reportIssues = report => Object.entries(report.issues || {}).filter(([, count]) => count > 0).map(([code, count]) => {
    const separator = code.lastIndexOf(':');
    return { code, field: separator < 0 ? '—' : code.slice(0, separator), reason: issueLabel(separator < 0 ? code : code.slice(separator + 1)), count };
}).sort((a, b) => b.count - a.count);

export function validationOutcome(report) {
    if (report.canImport === false || report.rejectedRows > 0) return { label: 'Validation blocked import', tone: 'error' };
    if (report.canImport !== true) return { label: 'Validation result unavailable', tone: 'neutral' };
    if (reportIssues(report).length) return { label: 'Passed with source data issues', tone: 'warning' };
    return { label: 'Validation passed', tone: 'success' };
}
