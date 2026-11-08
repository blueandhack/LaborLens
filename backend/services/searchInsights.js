const { buildSearch, metadataStages } = require('./caseSearch');
const { indexNames } = require('./searchConfig');
const { BoundedCache } = require('./boundedCache');

const cache = new BoundedCache({ capacity: 32, ttlMs: 60000 });
const SCHEMA_VERSION = 1;
const DAY_MS = 24 * 60 * 60 * 1000;
let active = false;

function insightsSpec(program, input = {}) {
    return buildSearch(program, { ...input, page: '1', limit: '20' });
}

function insightsPipeline(spec, query = spec.query, selectedHint, exclude) {
    const { config, filters } = spec;
    const hint = selectedHint || ([indexNames.certificationCompany, indexNames.certificationTitle].includes(spec.hint) ? spec.hint : filters.caseNumber.length >= 10 ? 'CASE_NUMBER_1'
        : filters.company || filters.employer ? indexNames.company : filters.jobTitle ? indexNames.title : indexNames.recent);
    const date = '$' + config.date;
    const year = { $cond: [{ $and: [
        { $eq: [{ $type: date }, 'date'] }, { $gte: [date, new Date('1901-01-01')] },
        { $lt: [date, new Date('2100-01-01')] },
    ] }, { $year: { date, timezone: 'UTC' } }, null] };
    const rawStatus = { $cond: [{ $eq: [{ $type: '$CASE_STATUS' }, 'string'] }, '$CASE_STATUS', ''] };
    const normalizedStatus = { $toUpper: { $trim: { input: '$_id.status' } } };
    const metadata = metadataStages(spec, query, hint, false, [config.date, 'CASE_STATUS', ...Object.keys(exclude || {})]);
    const leading = metadata[0].$match.$and || [];
    const residual = (query.$and || []).filter(condition => !leading.includes(condition));
    // Leading index predicates already ran before projection; don't repeat
    // regex evaluation for every matching record in a broad state/employer.
    if (leading.length) metadata[2].$match = residual.length ? { $and: residual } : {};
    return { hint, pipeline: [
        ...metadata,
        ...(exclude ? [{ $match: { $nor: [exclude] } }] : []),
        // Reduce the index stream once before splitting into chart summaries.
        // This avoids evaluating dates/statuses separately for every facet.
        { $group: { _id: { year, status: rawStatus }, count: { $sum: 1 } } },
        { $facet: {
            timeline: [{ $group: { _id: '$_id.year', count: { $sum: '$count' } } }, { $sort: { _id: 1 } }],
            outcomes: [
                // Normalize once per year/raw-status group, not once per case.
                { $group: { _id: { $let: { vars: { status: normalizedStatus },
                    in: { $cond: [{ $eq: ['$$status', ''] }, 'NOT REPORTED', '$$status'] } } }, count: { $sum: '$count' } } },
                { $sort: { count: -1, _id: 1 } }, { $limit: 1001 },
            ],
            total: [{ $group: { _id: null, count: { $sum: '$count' } } }],
        } },
    ] };
}

async function computeInsights(Model, program, input, { maxTimeMS = 5000, signal } = {}) {
    signal?.throwIfAborted();
    if (active) throw Object.assign(new Error('Insights are busy. Try again in a moment.'), { status: 503 });
    active = true;
    try {
        const spec = insightsSpec(program, input);
        // City and state are disjoint covered streams. Exclude city matches
        // from the state stream so overlapping prefixes count each case once.
        const scans = spec.branches ? [
            insightsPipeline(spec, spec.branches[0], spec.branchHints[0]),
            insightsPipeline(spec, spec.branches[1], spec.branchHints[1], spec.branches[0].$and.at(-1)),
        ] : [insightsPipeline(spec)];
        const deadline = Date.now() + maxTimeMS;
        const years = new Map(), statuses = new Map();
        let totalCount = 0;
        for (const { hint, pipeline } of scans) {
            const remaining = deadline - Date.now();
            if (remaining < 1) throw Object.assign(new Error('Insights timed out'), { status: 503 });
            const [result] = await Model.collection.aggregate(pipeline, {
                hint, maxTimeMS: remaining, signal, allowDiskUse: false, comment: 'laborlens-search-insights',
            }).toArray();
            if (result.outcomes.length > 1000) throw Object.assign(new Error('Too many distinct statuses. Narrow this search.'), { status: 503 });
            totalCount += result.total[0]?.count || 0;
            for (const row of result.timeline) years.set(row._id, (years.get(row._id) || 0) + row.count);
            for (const row of result.outcomes) statuses.set(row._id, (statuses.get(row._id) || 0) + row.count);
        }
        const outcomes = [...statuses].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
            .slice(0, 6).map(([status, count]) => ({ status, count }));
        const otherCount = totalCount - outcomes.reduce((sum, row) => sum + row.count, 0);
        if (otherCount > 0) outcomes.push({ status: 'Other statuses', count: otherCount, other: true });
        return {
            schemaVersion: SCHEMA_VERSION, program, totalCount,
            generatedAt: new Date().toISOString(), dateField: spec.config.date,
            timeline: [...years].filter(([year]) => year !== null).sort((a, b) => a[0] - b[0]).map(([year, count]) => ({ year, count })),
            missingDateCount: years.get(null) || 0,
            outcomes,
        };
    } finally { active = false; }
}

async function getSearchInsights(Model, program, input, { signal } = {}) {
    const spec = insightsSpec(program, input);
    signal?.throwIfAborted();
    const unfiltered = !Object.values(spec.filters).some(Boolean);
    if (unfiltered) {
        const state = await Model.db.collection('search_insights').findOne({ _id: program }, { maxTimeMS: 1000, signal });
        if (state?.snapshot?.schemaVersion === SCHEMA_VERSION) {
            return { ...state.snapshot, source: 'snapshot',
                stale: state.revision !== state.snapshot.revision || Date.now() - Date.parse(state.snapshot.generatedAt) > DAY_MS };
        }
    }
    // Shared work is bounded to five seconds. A disconnect stops that response,
    // while another reader of the same cached computation can still receive it.
    const result = await cache.get(JSON.stringify([Model.db.name, program, spec.filters]),
        () => computeInsights(Model, program, spec.filters));
    signal?.throwIfAborted();
    return { ...result, source: 'live', stale: false };
}

async function noteInsightsChange(db, program, { clear = false } = {}) {
    cache.clear();
    await db.collection('search_insights').updateOne({ _id: program }, {
        $inc: { revision: 1 }, $set: { changedAt: new Date() }, ...(clear ? { $unset: { snapshot: '' } } : {}),
    }, { upsert: true });
}

async function refreshGlobalInsights(Model, program, { force = false, signal } = {}) {
    const stateCollection = Model.db.collection('search_insights');
    await stateCollection.updateOne({ _id: program }, { $setOnInsert: { revision: 0 } }, { upsert: true });
    const state = await stateCollection.findOne({ _id: program });
    if (!force && state.snapshot?.schemaVersion === SCHEMA_VERSION && state.snapshot.revision === state.revision
            && Date.now() - Date.parse(state.snapshot.generatedAt) < DAY_MS) return { program, unchanged: true };
    const snapshot = { ...await computeInsights(Model, program, {}, { maxTimeMS: 60000, signal }), revision: state.revision };
    // Atomic revision check prevents a late refresh from resurrecting a snapshot
    // after an administrator clears data or another import changes the revision.
    const result = await stateCollection.updateOne({ _id: program, revision: state.revision }, { $set: { snapshot } });
    cache.clear();
    return { program, published: result.matchedCount === 1, totalCount: snapshot.totalCount, generatedAt: snapshot.generatedAt };
}

module.exports = { insightsSpec, insightsPipeline, computeInsights, getSearchInsights, noteInsightsChange,
    refreshGlobalInsights, invalidateInsights: () => cache.clear() };
