const { programs, indexNames } = require('./searchConfig');
const { BoundedCache } = require('./boundedCache');
const { slugFor } = require('./employers');

const counts = new BoundedCache();
const QUERY_MS = 10000;
let activeCounts = 0;
const escapeRegex = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const badRequest = message => Object.assign(new Error(message), { status: 400 });

function employerPrefix(value) {
    const parts = value.toLowerCase().match(/[\p{L}\p{N}]+/gu);
    // Retain a literal leading prefix for the existing employer index. Treat
    // punctuation/spacing between name parts alike without merging entities.
    return { $regex: '^' + (parts ? parts.map(escapeRegex).join('[^\\p{L}\\p{N}]*') : escapeRegex(value.toLowerCase())) };
}

function text(query, field) {
    const value = query[field];
    if (value === undefined) return '';
    if (typeof value !== 'string' || value.length > (field === 'employer' ? 512 : 160)) throw badRequest(`Invalid ${field}`);
    return field === 'employer' ? value : value.trim();
}

// Enumerate short ASCII identifiers so each expression has an indexable prefix.
// Longer or non-ASCII inputs retain the original case-insensitive regex behavior.
function insensitivePrefix(value) {
    let prefixes = [''];
    for (const char of value) {
        if (char.charCodeAt(0) > 127) return { $regex: `^${escapeRegex(value)}`, $options: 'i' };
        const variants = /[a-z]/i.test(char) ? [...new Set([char.toLowerCase(), char.toUpperCase(),
            ...(char.toLowerCase() === 'k' ? ['K'] : char.toLowerCase() === 's' ? ['ſ'] : [])])] : [char];
        if (prefixes.length * variants.length > 64) return { $regex: `^${escapeRegex(value)}`, $options: 'i' };
        prefixes = prefixes.flatMap(prefix => variants.map(variant => prefix + variant));
    }
    return { $in: prefixes.map(prefix => new RegExp(`^${escapeRegex(prefix)}`)) };
}

function buildSearch(program, input) {
    const config = programs[program];
    if (!config) throw badRequest('Invalid case program');
    const filters = Object.fromEntries(['company', 'employer', 'location', 'worksite', 'caseNumber', 'jobTitle', config.year, 'receivedYear']
        .map(field => [field, text(input, field)]));
    const page = input.page === undefined ? 1 : Number(text(input, 'page'));
    const limit = input.limit === undefined ? 20 : Number(text(input, 'limit'));
    if (!Number.isSafeInteger(page) || page < 1 || !Number.isInteger(limit) || limit < 1 || limit > 100 ||
            !Number.isSafeInteger((page - 1) * limit)) throw badRequest('Invalid page or limit (maximum 100 cases per page)');
    const conditions = [];
    const prefix = value => ({ $regex: `^${escapeRegex(value.toLowerCase())}` });
    if (filters.employer) conditions.push({ [config.company]: filters.employer.toLowerCase() });
    else if (filters.company) conditions.push({ [config.company]: employerPrefix(filters.company) });
    if (filters.jobTitle) conditions.push({ JOB_TITLE_LOWER: prefix(filters.jobTitle) });
    if (filters.caseNumber) conditions.push({ CASE_NUMBER: insensitivePrefix(filters.caseNumber) });
    const employerLocation = filters.location ? [
        { [config.city]: prefix(filters.location) }, { [config.state]: insensitivePrefix(filters.location) },
    ] : null;
    const location = filters.worksite ? [
        { _WORKSITE_CITY_LOWER: { ...prefix(filters.worksite), $gt: '' } },
        { _WORKSITE_STATE_LOWER: { ...prefix(filters.worksite), $gt: '' } },
    ] : employerLocation;
    if (filters.worksite && employerLocation) conditions.push({ $or: employerLocation });
    for (const [parameter, field] of [[config.year, config.date], ['receivedYear', 'RECEIVED_DATE']]) {
        const value = filters[parameter];
        if (!value) continue;
        if (!/^(?:19|20)\d{2}$/.test(value)) throw badRequest(`Invalid ${parameter}`);
        conditions.push({ [field]: { $gte: new Date(`${value}-01-01T00:00:00Z`),
            $lt: new Date(`${Number(value) + 1}-01-01T00:00:00Z`) } });
    }
    const query = conditions.length || location ? { $and: [...conditions, ...(location ? [{ $or: location }] : [])] } : {};
    let hint;
    if (filters.employer || filters.company) hint = indexNames.company;
    else if (filters.jobTitle) hint = indexNames.title;
    else if (filters.caseNumber.length >= 10) hint = 'CASE_NUMBER_1';
    else if (filters.receivedYear) hint = indexNames.received;
    else if (!location) hint = indexNames.recent;
    return { config, query, filters, hint, page, limit, skip: (page - 1) * limit,
        branches: location && (filters.worksite || !filters.company && !filters.employer && !filters.jobTitle && filters.caseNumber.length < 10)
            ? location.map(branch => ({ $and: [...conditions, branch] })) : null,
        branchHints: filters.worksite ? [indexNames.worksiteCity, indexNames.worksiteState] : [indexNames.city, indexNames.state],
        intersection: location ? { $and: [...conditions, ...location] } : null,
        sort: { [config.date]: -1, _id: 1 } };
}

function pageIds(collection, query, spec, signal, hint, skip = spec.skip, limit = spec.limit) {
    const complex = spec.filters.location || spec.filters.worksite || (spec.filters.company || spec.filters.employer) && (spec.filters.jobTitle || spec.filters.receivedYear || spec.filters.caseNumber)
        || spec.filters.jobTitle && (spec.filters.receivedYear || spec.filters.caseNumber);
    if (complex && hint && hint !== 'CASE_NUMBER_1') {
        return collection.aggregate([...metadataStages(spec, query, hint, true), { $sort: spec.sort },
            { $skip: skip }, { $limit: limit }, { $project: { _id: 1, [spec.config.date]: 1 } }],
        { hint, maxTimeMS: QUERY_MS, signal, allowDiskUse: true }).toArray();
    }
    return collection.find(query, { projection: { _id: 1, [spec.config.date]: 1 },
        maxTimeMS: QUERY_MS, signal, allowDiskUse: true, ...(hint ? { hint } : {}) })
        .sort(spec.sort).skip(skip).limit(limit).toArray();
}

function metadataStages(spec, query, hint, withDate = false, extraFields = []) {
    const fields = new Set(extraFields);
    function visit(value) {
        for (const [key, condition] of Object.entries(value)) {
            if (key === '$and' || key === '$or') condition.forEach(visit);
            else if (!key.startsWith('$')) fields.add(key);
        }
    }
    visit(query);
    const primary = ({ [indexNames.company]: spec.config.company, [indexNames.title]: 'JOB_TITLE_LOWER',
        [indexNames.city]: spec.config.city, [indexNames.state]: spec.config.state,
        [indexNames.worksiteCity]: '_WORKSITE_CITY_LOWER', [indexNames.worksiteState]: '_WORKSITE_STATE_LOWER',
        [indexNames.received]: 'RECEIVED_DATE', [indexNames.recent]: spec.config.date, [indexNames.worksiteRecent]: spec.config.date, CASE_NUMBER_1: 'CASE_NUMBER' })[hint];
    const leading = (query.$and || [query]).filter(condition => Object.hasOwn(condition, primary));
    const projection = { _id: withDate ? 1 : 0, ...(withDate ? { [spec.config.date]: 1 } : {}) };
    // A computed projection keeps residual OR/regex filters above the index-only
    // read. MongoDB otherwise fetches whole disclosures to evaluate those filters,
    // even when every required value is present in the covering index.
    for (const field of fields) projection[field] = { $ifNull: [`$${field}`, null] };
    const residual = (query.$and || [query]).filter(condition => !leading.includes(condition));
    // The index already applied leading predicates. Re-evaluating their regexes
    // after projection is costly for states/titles matching millions of cases.
    return [{ $match: leading.length ? { $and: leading } : {} }, { $project: projection },
        { $match: residual.length ? { $and: residual } : {} }];
}

async function locationPage(collection, spec, signal) {
    // The first K rows from each branch contain the first K of their union.
    // Bound application memory; deep pages retain MongoDB's disk-backed sort.
    const end = spec.skip + spec.limit;
    if (end > 2000) return pageIds(collection, spec.query, spec, signal);
    const pages = await Promise.all(spec.branches.map((query, index) =>
        pageIds(collection, query, spec, signal, spec.branchHints[index], 0, end)));
    const rows = [...new Map(pages.flat().map(row => [String(row._id), row])).values()];
    // Older malformed date values retain MongoDB's BSON ordering via fallback.
    if (rows.some(row => row[spec.config.date] != null && !(row[spec.config.date] instanceof Date))) {
        return pageIds(collection, spec.query, spec, signal);
    }
    rows.sort((a, b) => {
        const first = a[spec.config.date], second = b[spec.config.date];
        const order = first == null ? (second == null ? 0 : 1)
            : second == null ? -1 : second.getTime() - first.getTime();
        return order || String(a._id).localeCompare(String(b._id));
    });
    return rows.slice(spec.skip, end);
}

const countKey = (program, spec) => JSON.stringify([program, spec.filters]);

async function totalFor(Model, program, spec) {
    const { query, hint } = spec;
    const collection = Model.collection;
    const hasFilters = Object.keys(query).length > 0;
    const count = async (query, hint) => {
        const condition = query.$and?.length === 1 && query.$and[0];
        if (!hint || condition && !condition.$or && !Object.values(condition)[0].$in) {
            return collection.countDocuments(query, { maxTimeMS: QUERY_MS, ...(hint ? { hint } : {}) });
        }
        const rows = await collection.aggregate([...metadataStages(spec, query, hint), { $count: 'total' }],
            { hint, maxTimeMS: QUERY_MS }).toArray();
        return rows[0]?.total || 0;
    };
    return counts.get(countKey(program, spec), async () => {
        // Coalesced counts may finish after their browser disconnects, allowing
        // another page to reuse the answer. Bound that work independently of
        // case retrieval; there is no queue of expensive count scans.
        if (activeCounts >= 2) throw Object.assign(new Error('Total counts are busy. Try again shortly.'), { status: 503 });
        activeCounts++;
        try {
            if (spec.branches) {
                const [city, state, overlap] = await Promise.allSettled([
                    count(spec.branches[0], spec.branchHints[0]), count(spec.branches[1], spec.branchHints[1]),
                    count(spec.intersection, spec.branchHints[0]),
                ]);
                // Keep the concurrency slot until every branch has stopped.
                for (const result of [city, state, overlap]) if (result.status === 'rejected') throw result.reason;
                return city.value + state.value - overlap.value;
            }
            return await (hasFilters ? count(query, hint) : collection.estimatedDocumentCount({ maxTimeMS: QUERY_MS }));
        } finally { activeCounts--; }
    });
}

async function countCases(Model, program, input, { signal } = {}) {
    signal?.throwIfAborted();
    const totalCount = await totalFor(Model, program, buildSearch(program, input));
    signal?.throwIfAborted();
    return { totalCount };
}

async function searchCases(Model, program, input, { signal } = {}) {
    signal?.throwIfAborted();
    if (input.count !== undefined && !['deferred', 'exact'].includes(input.count)) throw badRequest('Invalid count mode');
    const spec = buildSearch(program, input);
    const { config, query, hint, page, limit } = spec;
    const collection = Model.collection;
    const hasFilters = Object.keys(query).length > 0;
    const deferred = input.count === 'deferred';
    // Sorting only IDs + indexed sort values avoids fetching thousands of large
    // disclosure documents. Fetch the small projected page after sorting.
    const totalCount = deferred ? counts.peek(countKey(program, spec)) ?? null : await totalFor(Model, program, spec);
    signal?.throwIfAborted();
    // One extra ID answers whether Next is available without an exact total.
    const selection = deferred ? { ...spec, limit: limit + 1 } : spec;
    let ids;
    if (totalCount !== null && (!totalCount || spec.skip >= totalCount)) ids = [];
    else {
        // Common filters usually match recent records. Stream a covered date-first
        // index and stop at a page instead of sorting hundreds of thousands of IDs.
        // A short trial budget protects rare/historical queries; those fall back
        // to their selective prefix index.
        if (hasFilters && (totalCount === null || totalCount >= 1000) && spec.skip + selection.limit <= 2000 && !spec.filters.receivedYear) {
            const recentHint = spec.filters.worksite ? indexNames.worksiteRecent : indexNames.recent;
            const stages = metadataStages(spec, query, recentHint, true);
            stages[1].$project[config.date] = 1;
            try {
                // The bounded window also fences MongoDB's optimizer: without
                // this stage it moves sort after computed filters and scans the
                // entire recent index before returning the first page.
                const window = Math.min(20000, Math.max(5000, (spec.skip + selection.limit) * 100));
                ids = await collection.aggregate([stages[0], { $sort: spec.sort }, { $limit: window }, stages[1], stages[2],
                    { $skip: spec.skip }, { $limit: selection.limit }, { $project: { _id: 1, [config.date]: 1 } }],
                { hint: recentHint, maxTimeMS: 500, signal }).toArray();
                if (ids.length < (totalCount === null ? selection.limit : Math.min(selection.limit, totalCount - spec.skip))) ids = undefined;
            } catch (error) {
                if (error.code !== 50 || signal?.aborted) throw error;
            }
        }
        if (!ids) ids = await (spec.branches ? locationPage(collection, selection, signal) : pageIds(collection, query, selection, signal, hint));
    }
    const hasNextPage = deferred ? ids.length > limit : spec.skip + ids.length < totalCount;
    // A complete first page smaller than the limit is already an exact count.
    // This also avoids a second request for empty and very specific searches.
    const knownTotal = deferred && spec.skip === 0 && !hasNextPage ? ids.length : totalCount;
    ids = ids.slice(0, limit);
    const projection = Object.fromEntries(config.fields.map(field => [field, 1]));
    projection[config.company] = 1;
    const rows = ids.length ? await collection.find({ _id: { $in: ids.map(row => row._id) } },
        { projection, maxTimeMS: QUERY_MS, signal }).toArray() : [];
    const byId = new Map(rows.map(row => [String(row._id), row]));
    const cases = ids.map(row => byId.get(String(row._id))).filter(Boolean);
    for (const row of cases) {
        const key = row[config.company] || row[config.employer]?.toLowerCase();
        if (typeof key === 'string' && key) row.EMPLOYER_PROFILE_SLUG = slugFor(key);
        delete row[config.company];
    }
    if (program === 'perm' && cases.length) {
        const numbers = [...new Set(cases.map(row => row.JOB_OPP_PWD_NUMBER).filter(value => typeof value === 'string' && value))];
        const pwd = numbers.length ? await Model.db.collection('cases').find({ CASE_NUMBER: { $in: numbers } }, {
            projection: { CASE_NUMBER: 1, DETERMINATION_DATE: 1, RECEIVED_DATE: 1, PWD_WAGE_EXPIRATION_DATE: 1 },
            maxTimeMS: QUERY_MS, signal,
        }).toArray() : [];
        const related = new Map(pwd.map(row => [row.CASE_NUMBER, row]));
        for (const row of cases) {
            const match = related.get(row.JOB_OPP_PWD_NUMBER);
            if (match) Object.assign(row, { PWD_DETERMINATION_DATE: match.DETERMINATION_DATE,
                PWD_RECEIVED_DATE: match.RECEIVED_DATE, PWD_EXPIRATION_DATE: match.PWD_WAGE_EXPIRATION_DATE });
        }
    }
    return { cases, totalPages: knownTotal === null ? null : Math.ceil(knownTotal / limit), currentPage: page, totalCount: knownTotal,
        ...(deferred ? { hasNextPage } : {}) };
}

module.exports = { buildSearch, insensitivePrefix, searchCases, countCases, metadataStages, invalidateCounts: () => counts.clear() };
