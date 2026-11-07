const TYPES = ['h1b', 'pwd', 'perm'];
const PROCESSING = new Set(['downloading', 'validating', 'importing']);
const ATTENTION = new Set(['error', 'interrupted', 'blocked']);
const period = file => /_Q[1-4](?:_|\.xlsx$)/i.test(file.filename || '') ? 'quarterly' : 'annual';
const quarter = file => Number(file.quarter) || Number(file.filename?.match(/_Q([1-4])(?:_|\.xlsx$)/i)?.[1]) || 4;
const complete = (file, version) => file.status === 'done' && file.validation?.version === version && file.validation?.canImport !== false;

function normalizedSources(sources, active) {
    return sources.map(source => PROCESSING.has(source.status) && (!active?.runId || source.runId !== active.runId)
        ? { ...source, status: 'interrupted' } : source);
}

function fileProgress(file) {
    if (!PROCESSING.has(file.status)) return null;
    if (file.status === 'importing') {
        const total = file.validation?.uniqueCases;
        const processed = file.progress?.processed || 0;
        return { stage: 'importing', processed, total: Number.isFinite(total) && total > 0 ? total : null,
            percentage: Number.isFinite(total) && total > 0 ? Math.min(100, Math.floor(processed / total * 100)) : null,
            inserted: file.progress?.inserted || 0, updated: file.progress?.updated || 0,
            protected: file.progress?.protected || 0, supplemented: file.progress?.supplemented || 0 };
    }
    return { stage: file.status, processed: file.status === 'validating' ? file.validationProgress?.rows || 0 : null, total: null, percentage: null };
}

function summarizeGroup(files, version) {
    const completed = files.filter(file => complete(file, version)).length;
    const active = files.find(file => PROCESSING.has(file.status));
    const failed = files.find(file => ATTENTION.has(file.status));
    if (completed === files.length && files.length) return { state: 'imported', completed };
    if (active) return { state: 'active', completed, active };
    if (failed) return { state: 'attention', completed };
    return { state: completed ? 'partial' : 'pending', completed };
}

function quarterCoverage(files, targets, q, version, inventoryKnown) {
    const direct = files.filter(file => file.quarter === q && file.period === 'quarterly');
    if (direct.length) {
        const summary = summarizeGroup(direct, version);
        if (summary.state === 'imported') return { quarter: q, state: 'imported', label: 'Imported', fileUrls: direct.map(file => file.url), directUrls: direct.map(file => file.url) };
    }
    const covering = files.filter(file => file.quarter >= q && (file.quarter > q || file.period === 'annual'));
    // A group can contain independent legacy files or form variants. Never
    // call a quarter covered because only one file in that release is done.
    const releases = [...new Set(covering.map(file => file.quarter))].sort((a, b) => b - a);
    for (const release of releases) {
        const group = files.filter(file => file.quarter === release);
        if (group.length && group.every(file => complete(file, version))) {
            return { quarter: q, state: 'covered', label: 'Covered', viaQuarter: release,
                viaAnnual: group.every(file => file.period === 'annual'), fileUrls: group.map(file => file.url), directUrls: direct.map(file => file.url) };
        }
    }
    const planned = targets.filter(file => file.quarter >= q);
    const group = planned.length ? planned : direct;
    if (!group.length) return { quarter: q, state: inventoryKnown ? 'unavailable' : 'unknown', label: inventoryKnown ? 'Not listed' : 'Unknown', fileUrls: [], directUrls: [] };
    const summary = summarizeGroup(group, version);
    const labels = { active: 'In progress', attention: 'Needs attention', partial: 'Partial', pending: 'Queued' };
    return { quarter: q, state: summary.state, label: labels[summary.state] || 'Queued',
        viaQuarter: Math.max(...group.map(file => file.quarter)), viaAnnual: group.every(file => file.period === 'annual'),
        completedFiles: summary.completed, totalFiles: group.length,
        fileUrls: group.map(file => file.url), directUrls: direct.map(file => file.url) };
}

function buildImportCoverage({ catalog, sources = [], active = null, validationVersion, now = new Date() }) {
    const normalized = normalizedSources(sources, active);
    const all = new Map();
    for (const file of [...(catalog?.releases || []), ...(catalog?.datasets || []), ...normalized]) {
        if (!TYPES.includes(file.type) || !Number.isInteger(Number(file.fiscalYear)) || !file.url) continue;
        all.set(file.url, { ...all.get(file.url), ...file, fiscalYear: Number(file.fiscalYear), quarter: quarter(file), period: period(file) });
    }
    const years = [...all.values()].map(file => file.fiscalYear);
    const fromYear = years.length ? Math.min(catalog?.fromYear || Infinity, ...years) : catalog?.fromYear || null;
    const toYear = years.length ? Math.max(...years) : null;
    const inventory = [...(catalog?.releases || []), ...(catalog?.datasets || [])];
    const latest = new Map();
    for (const file of inventory) {
        const key = `${file.type}:${file.fiscalYear}`;
        latest.set(key, Math.max(latest.get(key) || 0, quarter(file)));
    }
    const targetUrls = new Set(inventory.filter(file => quarter(file) === latest.get(`${file.type}:${file.fiscalYear}`)).map(file => file.url));
    const programs = TYPES.map(type => {
        const files = [...all.values()].filter(file => file.type === type).map(file => ({ ...file, required: targetUrls.has(file.url) }));
        const targets = files.filter(file => file.required);
        const imported = targets.filter(file => complete(file, validationVersion));
        const current = files.filter(file => PROCESSING.has(file.status));
        const attention = targets.filter(file => ATTENTION.has(file.status));
        const pending = targets.filter(file => !complete(file, validationVersion) && !PROCESSING.has(file.status) && !ATTENTION.has(file.status));
        const inventoryKnown = targets.length > 0;
        const rows = [];
        if (fromYear && toYear) for (let year = toYear; year >= fromYear; year--) {
            const yearFiles = files.filter(file => file.fiscalYear === year);
            const yearTargets = targets.filter(file => file.fiscalYear === year);
            rows.push({ fiscalYear: year, quarters: [1, 2, 3, 4].map(q => quarterCoverage(yearFiles, yearTargets, q, validationVersion, inventoryKnown)) });
        }
        return { type, inventoryKnown, totalFiles: inventoryKnown ? targets.length : null,
            completedFiles: imported.length, activeFiles: current.length, attentionFiles: attention.length, pendingFiles: pending.length,
            percentage: inventoryKnown ? Math.floor(imported.length / targets.length * 100) : null,
            state: current.length ? 'active' : attention.length ? 'attention' : inventoryKnown && imported.length === targets.length ? 'complete' : 'waiting',
            current: current.map(file => ({ url: file.url, filename: file.filename, fiscalYear: file.fiscalYear, quarter: file.quarter, period: file.period, ...fileProgress(file) })),
            // Detailed reports are fetched only on demand; keep polling small.
            files: files.map(file => ({ url: file.url, filename: file.filename, fiscalYear: file.fiscalYear, quarter: file.quarter, period: file.period,
                required: file.required, sourceId: file._id || null, status: complete(file, validationVersion) ? 'done' : file.status === 'done' ? 'revalidation' : file.status || 'pending',
                progress: file.progress, validationProgress: file.validationProgress, completedAt: file.completedAt,
                checkedAt: file.checkedAt, error: file.error, canViewReport: Boolean(file.validation) })), years: rows };
    });
    return { asOf: now, inventoryCheckedAt: catalog?.releasesCheckedAt || catalog?.checkedAt || null,
        publishedQuarterInventory: Boolean(catalog?.releases), fromYear, toYear, programs };
}

module.exports = { buildImportCoverage, normalizedSources, fileProgress };
