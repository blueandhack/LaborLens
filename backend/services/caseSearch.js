const { programs, indexNames } = require('./searchConfig');
const { BoundedCache } = require('./boundedCache');
const { findIdentity, identityForQuery, profileSlugs, slugFor } = require('./employerIdentity');
const { groupForQuery } = require('./employerGroups');
const { stateValues } = require('./geo');

const counts = new BoundedCache();
const employerGroups = new BoundedCache({ capacity: 256, ttlMs: 60000 });
const QUERY_MS = 10000;
let activeCounts = 0;
const escapeRegex = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const badRequest = message => Object.assign(new Error(message), { status: 400 });
// Date range predicates retain covered index reads; $type can force MongoDB
// to fetch full disclosures to check whether an indexed value came from an array.
const dateRange = () => ({ $gte: new Date(-8640000000000000), $lte: new Date(8640000000000000) });
const sortProjection = spec => Object.fromEntries(Object.keys(spec.sort).map(field => [field, 1]));
function compareRows(a, b, sort) {
    for (const [field, direction] of Object.entries(sort)) {
        const first = field === '_id' ? String(a[field]) : a[field]?.getTime() ?? null;
        const second = field === '_id' ? String(b[field]) : b[field]?.getTime() ?? null;
        const order = first == null ? (second == null ? 0 : -1) : second == null ? 1 : first < second ? -1 : first > second ? 1 : 0;
        if (order) return direction * order;
    }
    return 0;
}

function constrained(spec, ...conditions) {
    const append = query => ({ $and: [...(query.$and || (Object.keys(query).length ? [query] : [])), ...conditions] });
    return { ...spec, query: append(spec.query), branches: spec.branches?.map(append),
        intersection: spec.intersection && append(spec.intersection) };
}

async function selectionCount(collection, spec, signal) {
    const count = async (query, hint) => {
        const rows = await collection.aggregate([...metadataStages(spec, query, hint), { $count: 'total' }],
            { hint, maxTimeMS: QUERY_MS, signal }).toArray();
        return rows[0]?.total || 0;
    };
    if (!spec.branches) return count(spec.query, spec.hint);
    const [city, state, overlap] = await Promise.all([count(spec.branches[0], spec.branchHints[0]),
        count(spec.branches[1], spec.branchHints[1]), count(spec.intersection, spec.branchHints[0])]);
    return city + state - overlap;
}

async function appendUndated(collection, spec, rows, datedCount, missing, signal) {
    if (rows.length >= spec.limit) return rows;
    const skip = rows.length || !spec.skip ? 0 : Math.max(0, spec.skip - await datedCount());
    const rest = { ...missing, skip, limit: spec.limit - rows.length, sort: { _id: 1 }, sortField: '_id', forceMetadata: true };
    return rows.concat(await selectIds(collection, rest, null, signal));
}

async function certificationIds(collection, spec, signal) {
    // DOL defines ORIGINAL_CERT_DATE for Certified-Withdrawn applications.
    // A currently Certified application's determination is its certification.
    // Never substitute a withdrawal/denial action for an absent certification.
    const certified = /^\s*certified\s*$/i;
    const certificateHint = spec.filters.employer || spec.filters.employerGroup || spec.filters.company ? indexNames.certificationCompany
        : spec.filters.jobTitle ? indexNames.certificationTitle : spec.filters.caseNumber.length >= 10 ? 'CASE_NUMBER_1' : indexNames.certification;
    const current = constrained({ ...spec, sortKey: 'event_' + (spec.direction === 1 ? 'asc' : 'desc') },
        { CASE_STATUS: certified }, { DECISION_DATE: dateRange() });
    if (certificateHint === 'CASE_NUMBER_1') current.skipTrial = true;
    if (spec.filters.worksite && [indexNames.certificationCompany, indexNames.certificationTitle, 'CASE_NUMBER_1'].includes(certificateHint)) {
        // Select rare employers before their worksite: a missing CA match must
        // not require scanning millions of California applications.
        current.hint = certificateHint; current.branches = null; current.intersection = null; current.skipTrial = true;
    }
    if (!current.hint || current.hint === indexNames.received) current.hint = spec.filters.worksite || spec.filters.worksiteState ? indexNames.worksiteRecent : indexNames.recent;
    const original = constrained({ ...spec, branches: null, intersection: null, hint: certificateHint,
        sort: { ORIGINAL_CERT_DATE: spec.direction, _id: -spec.direction }, sortField: 'ORIGINAL_CERT_DATE',
        recentHint: certificateHint === indexNames.certification ? indexNames.certification : undefined,
        leadingFields: ['ORIGINAL_CERT_DATE'], forceMetadata: true },
    { ORIGINAL_CERT_DATE: dateRange() }, { CASE_STATUS: { $not: certified } });
    const end = spec.skip + spec.limit;
    let rows;
    if (end <= 2000) {
        const [a, b] = await Promise.all([selectIds(collection, { ...original, skip: 0, limit: end }, null, signal),
            selectIds(collection, { ...current, skip: 0, limit: end }, null, signal)]);
        rows = [...a.map(row => ({ ...row, _certificationSort: row.ORIGINAL_CERT_DATE })),
            ...b.map(row => ({ ...row, _certificationSort: row.DECISION_DATE }))]
            .sort((a, b) => compareRows(a, b, { _certificationSort: spec.direction, _id: -spec.direction })).slice(spec.skip, end);
    } else if (!spec.filters.worksite || !(spec.filters.company || spec.filters.employer || spec.filters.employerGroup || spec.filters.jobTitle)) {
        // Fence the ordered index scans before computed filters. MongoDB can
        // otherwise move a sort past those filters and scan the whole history.
        const deadline = Date.now() + QUERY_MS;
        const remaining = () => {
            signal?.throwIfAborted();
            const ms = deadline - Date.now();
            if (ms < 1) throw Object.assign(new Error('Sorting timed out. Narrow the search and try again.'), { status: 503 });
            return ms;
        };
        const bounds = {};
        let window = Math.max(5000, Math.min(200000, end * 2));
        while (true) {
            const stream = (branch, name) => {
                const [match, projection, residual] = metadataStages(branch, branch.query, branch.hint, true);
                return [match, { $sort: branch.sort }, { $limit: window }, projection, residual, { $limit: end },
                    { $project: { _id: 1, _certificationSort: '$' + branch.sortField, _branch: { $literal: name } } }];
            };
            const [result] = await collection.aggregate([...stream(original, 'original'),
                { $unionWith: { coll: spec.config.collection, pipeline: stream(current, 'current') } },
                { $sort: { _certificationSort: spec.direction, _id: -spec.direction } },
                { $facet: { page: [{ $skip: spec.skip }, { $limit: spec.limit }], counts: [{ $group: { _id: '$_branch', count: { $sum: 1 } } }] } },
            ], { hint: certificateHint, maxTimeMS: remaining(), allowDiskUse: true, signal }).toArray();
            const counts = Object.fromEntries(result.counts.map(row => [row._id, row.count]));
            let complete = true;
            for (const [name, branch] of [['original', original], ['current', current]]) {
                if ((counts[name] || 0) >= end) continue;
                if (bounds[name] === undefined) {
                    const leading = metadataStages(branch, branch.query, branch.hint)[0].$match;
                    bounds[name] = await collection.countDocuments(leading, { hint: branch.hint, maxTimeMS: remaining(), signal });
                }
                if (window < bounds[name]) complete = false;
            }
            if (complete) { rows = result.page; break; }
            window = Math.min(Number.MAX_SAFE_INTEGER, window * 2);
        }
    } else {
        // Combined prefix/worksite queries use their covering prefix index;
        // every matching disclosure stays outside application memory.
        rows = await collection.aggregate([
            ...metadataStages(spec, spec.query, certificateHint, false, ['_id', 'CASE_STATUS', 'DECISION_DATE', 'ORIGINAL_CERT_DATE']),
            { $project: { _id: 1, _certificationSort: { $cond: [
                { $regexMatch: { input: { $ifNull: ['$CASE_STATUS', ''] }, regex: certified } }, '$DECISION_DATE', '$ORIGINAL_CERT_DATE',
            ] } } }, { $match: { _certificationSort: dateRange() } },
            { $sort: { _certificationSort: spec.direction, _id: -spec.direction } }, { $skip: spec.skip }, { $limit: spec.limit },
        ], { hint: certificateHint, maxTimeMS: QUERY_MS, allowDiskUse: true, signal }).toArray();
    }
    const undated = { $nor: [{ CASE_STATUS: certified, DECISION_DATE: dateRange() },
        { CASE_STATUS: { $not: certified }, ORIGINAL_CERT_DATE: dateRange() }] };
    let missing = constrained({ ...spec, branches: null, intersection: null, hint: certificateHint }, undated);
    if (certificateHint === indexNames.certification && !rows.length && !spec.skip) {
        // Empty/sparse location and case-number searches should establish that
        // absence through their prefix index, rather than scan all history.
        if (spec.filters.worksite || spec.filters.worksiteState || spec.filters.location) missing = constrained(spec, undated);
        else if (spec.filters.caseNumber) missing.hint = 'CASE_NUMBER_1';
    }
    return appendUndated(collection, spec, rows, async () => {
        const [a, b] = await Promise.all([selectionCount(collection, original, signal), selectionCount(collection, current, signal)]);
        return a + b;
    }, missing, signal);
}

async function sortedIds(collection, spec, totalCount, signal) {
    if (totalCount === 0 || totalCount !== null && spec.skip >= totalCount) return [];
    if (spec.sortKey.startsWith('certification_')) return certificationIds(collection, spec, signal);
    if (spec.direction === -1) return selectIds(collection, spec, totalCount, signal);
    const dated = constrained(spec, { [spec.sortField]: dateRange() });
    const rows = await selectIds(collection, dated, null, signal);
    return appendUndated(collection, spec, rows, () => selectionCount(collection, dated, signal),
        constrained(spec, { [spec.sortField]: { $not: dateRange() } }), signal);
}

// Resolves employerGroup (an identity ID or included reported-name ID), or a
// typed complete reviewed name, to the identity's exact reported names.
async function resolveEmployerGroup(db, input) {
    const id = text(input, 'employerGroup'), company = text(input, 'company');
    if (text(input, 'employer') || !id && !(company && groupForQuery(company))) return null;
    if (!db) throw Object.assign(new Error('Employer groups require a database connection'), { status: 503 });
    return employerGroups.get(JSON.stringify([db.databaseName, id, id ? '' : company]), async () => {
        const identity = id ? await findIdentity(db, id) : await identityForQuery(db, company);
        return identity ? { id: identity._id, key: identity.key, name: identity.name, slug: identity.slug || slugFor(identity.key), keys: identity.keys } : null;
    });
}

// Synchronous unless an employer group must be read, preserving the scheduling
// of ordinary searches (counts start in the same tick as their request).
function resolveSearch(Model, program, input) {
    const needsGroup = !text(input, 'employer') && (text(input, 'employerGroup') || groupForQuery(text(input, 'company')));
    return needsGroup ? resolveEmployerGroup(Model.db?.db, input).then(group => buildSearch(program, input, group)) : buildSearch(program, input);
}

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

function buildSearch(program, input, group = null) {
    const config = programs[program];
    if (!config) throw badRequest('Invalid case program');
    const sortKey = text(input, 'sort') || 'event_desc';
    if (!['event_desc', 'event_asc', 'received_desc', 'received_asc', ...(program === 'h1b' ? ['certification_desc', 'certification_asc'] : [])].includes(sortKey)) throw badRequest('Invalid sort');
    const direction = sortKey.endsWith('_asc') ? 1 : -1;
    const sortField = sortKey.startsWith('received_') ? 'RECEIVED_DATE' : config.date;
    const sort = { [sortField]: direction, ...(sortField !== config.date ? { [config.date]: direction } : {}), _id: -direction };
    const filters = Object.fromEntries(['company', 'employer', 'employerGroup', 'location', 'worksite', 'worksiteState', 'caseNumber', 'jobTitle', config.year, 'receivedYear']
        .map(field => [field, text(input, field)]));
    const page = input.page === undefined ? 1 : Number(text(input, 'page'));
    const limit = input.limit === undefined ? 20 : Number(text(input, 'limit'));
    if (!Number.isSafeInteger(page) || page < 1 || !Number.isInteger(limit) || limit < 1 || limit > 100 ||
            !Number.isSafeInteger((page - 1) * limit)) throw badRequest('Invalid page or limit (maximum 100 cases per page)');
    const conditions = [];
    const prefix = value => ({ $regex: `^${escapeRegex(value.toLowerCase())}` });
    if (filters.employer && filters.employerGroup) throw badRequest('Choose either an employer group or an exact reported name');
    // An employer identity (resolved by resolveEmployerGroup) combines its reported filing names.
    if (filters.employerGroup && !group) throw badRequest('Unknown employer group');
    const employerGroup = filters.employer ? null : group;
    if (employerGroup) { filters.employerGroup = employerGroup.id; conditions.push({ [config.company]: { $in: employerGroup.keys } }); }
    else if (filters.employer) conditions.push({ [config.company]: filters.employer.toLowerCase() });
    else if (filters.company) conditions.push({ [config.company]: employerPrefix(filters.company) });
    if (filters.jobTitle) conditions.push({ JOB_TITLE_LOWER: prefix(filters.jobTitle) });
    if (filters.caseNumber) {
        const match = insensitivePrefix(filters.caseNumber);
        if (match.$options) {
            // Keep long, letter-heavy identifiers indexable without weakening
            // their original Unicode/case-insensitive full-prefix match.
            let prefix = '';
            for (const char of filters.caseNumber) {
                if (insensitivePrefix(prefix + char).$options) break;
                prefix += char;
            }
            if (prefix) conditions.push({ CASE_NUMBER: insensitivePrefix(prefix) });
        }
        conditions.push({ CASE_NUMBER: match });
    }
    const employerLocation = filters.location ? [
        { [config.city]: prefix(filters.location) }, { [config.state]: insensitivePrefix(filters.location) },
    ] : null;
    // A worksite state is an exact state (postal code or name, as reported).
    // With a state, the worksite text matches the worksite city only.
    const worksiteStates = filters.worksiteState ? stateValues(filters.worksiteState) : null;
    if (filters.worksiteState && !worksiteStates) throw badRequest('Invalid worksiteState');
    if (worksiteStates) { filters.worksiteState = filters.worksiteState.toUpperCase(); conditions.push({ _WORKSITE_STATE_LOWER: { $in: worksiteStates, $gt: '' } }); }
    const cityOnly = Boolean(filters.worksite && worksiteStates);
    if (cityOnly) conditions.push({ _WORKSITE_CITY_LOWER: { ...prefix(filters.worksite), $gt: '' } });
    const location = filters.worksite && !cityOnly ? [
        { _WORKSITE_CITY_LOWER: { ...prefix(filters.worksite), $gt: '' } },
        { _WORKSITE_STATE_LOWER: { ...prefix(filters.worksite), $gt: '' } },
    ] : employerLocation;
    if (filters.worksite && !cityOnly && employerLocation) conditions.push({ $or: employerLocation });
    for (const [parameter, field] of [[config.year, config.date], ['receivedYear', 'RECEIVED_DATE']]) {
        const value = filters[parameter];
        if (!value) continue;
        if (!/^(?:19|20)\d{2}$/.test(value)) throw badRequest(`Invalid ${parameter}`);
        conditions.push({ [field]: { $gte: new Date(`${value}-01-01T00:00:00Z`),
            $lt: new Date(`${Number(value) + 1}-01-01T00:00:00Z`) } });
    }
    const query = conditions.length || location ? { $and: [...conditions, ...(location ? [{ $or: location }] : [])] } : {};
    let hint;
    if (filters.employer || filters.employerGroup || filters.company) hint = indexNames.company;
    else if (filters.jobTitle) hint = indexNames.title;
    else if (filters.caseNumber.length >= 10) hint = 'CASE_NUMBER_1';
    else if (filters.receivedYear) hint = indexNames.received;
    else if (cityOnly && !location) hint = indexNames.worksiteCity;
    else if (worksiteStates && !location) hint = indexNames.worksiteState;
    else if (!location) hint = indexNames.recent;
    const worksitePrefix = program === 'h1b' && filters.worksite && (filters.employer || filters.employerGroup || filters.company || filters.jobTitle);
    if (worksitePrefix) hint = filters.employer || filters.employerGroup || filters.company ? indexNames.certificationCompany : indexNames.certificationTitle;
    if (sortField === 'RECEIVED_DATE' && !(filters.employer || filters.employerGroup || filters.company || filters.jobTitle || filters.caseNumber || location)) hint = indexNames.received;
    return { config, query, filters, hint, page, limit, skip: (page - 1) * limit,
        branches: location && !worksitePrefix && (filters.worksite || !filters.company && !filters.employer && !filters.employerGroup && !filters.jobTitle && filters.caseNumber.length < 10)
            ? location.map(branch => ({ $and: [...conditions, branch] })) : null,
        branchHints: filters.worksite && !cityOnly ? [indexNames.worksiteCity, indexNames.worksiteState] : [indexNames.city, indexNames.state],
        intersection: location ? { $and: [...conditions, ...location] } : null,
        sort, sortKey, sortField, direction, employerGroup };
}

function pageIds(collection, query, spec, signal, hint, skip = spec.skip, limit = spec.limit) {
    const complex = spec.forceMetadata || spec.filters.location || spec.filters.worksite || spec.filters.worksiteState || (spec.filters.company || spec.filters.employer || spec.filters.employerGroup) && (spec.filters.jobTitle || spec.filters.receivedYear || spec.filters.caseNumber)
        || spec.filters.jobTitle && (spec.filters.receivedYear || spec.filters.caseNumber);
    if (complex && hint && hint !== 'CASE_NUMBER_1') {
        return collection.aggregate([...metadataStages(spec, query, hint, true), { $sort: spec.sort },
            { $skip: skip }, { $limit: limit }, { $project: sortProjection(spec) }],
        { hint, maxTimeMS: QUERY_MS, signal, allowDiskUse: true }).toArray();
    }
    return collection.find(query, { projection: sortProjection(spec),
        maxTimeMS: QUERY_MS, signal, allowDiskUse: true, ...(hint ? { hint } : {}) })
        .sort(spec.sort).skip(skip).limit(limit).toArray();
}

function metadataStages(spec, query, hint, withDate = false, extraFields = []) {
    const fields = new Set(extraFields);
    function visit(value) {
        for (const [key, condition] of Object.entries(value)) {
            if (key === '$and' || key === '$or' || key === '$nor') condition.forEach(visit);
            else if (!key.startsWith('$')) fields.add(key);
        }
    }
    visit(query);
    const primary = ({ [indexNames.company]: spec.config.company, [indexNames.title]: 'JOB_TITLE_LOWER',
        [indexNames.city]: spec.config.city, [indexNames.state]: spec.config.state,
        [indexNames.worksiteCity]: '_WORKSITE_CITY_LOWER', [indexNames.worksiteState]: '_WORKSITE_STATE_LOWER',
        [indexNames.received]: 'RECEIVED_DATE', [indexNames.recent]: spec.config.date, [indexNames.worksiteRecent]: spec.config.date,
        [indexNames.certification]: 'ORIGINAL_CERT_DATE', [indexNames.certificationCompany]: spec.config.company,
        [indexNames.certificationTitle]: 'JOB_TITLE_LOWER', CASE_NUMBER_1: 'CASE_NUMBER' })[hint];
    const leading = (query.$and || [query]).filter(condition => Object.hasOwn(condition, primary)
        || spec.leadingFields?.some(field => Object.hasOwn(condition, field)));
    // Prove the partial index's membership when adding a leading date range.
    // Otherwise MongoDB can keep the date predicate as a FETCH filter and read
    // every full disclosure, despite all requested values being indexed.
    const indexMatch = hint === indexNames.worksiteRecent && leading.length ? [...leading,
        { $or: [{ _WORKSITE_CITY_LOWER: { $gt: '' } }, { _WORKSITE_STATE_LOWER: { $gt: '' } }] }] : leading;
    const projection = withDate ? sortProjection(spec) : { _id: 0 };
    // A computed projection keeps residual OR/regex filters above the index-only
    // read. MongoDB otherwise fetches whole disclosures to evaluate those filters,
    // even when every required value is present in the covering index.
    for (const field of fields) projection[field] = { $ifNull: [`$${field}`, null] };
    if (withDate) Object.assign(projection, sortProjection(spec));
    const residual = (query.$and || [query]).filter(condition => !leading.includes(condition));
    // The index already applied leading predicates. Re-evaluating their regexes
    // after projection is costly for states/titles matching millions of cases.
    return [{ $match: indexMatch.length ? { $and: indexMatch } : {} }, { $project: projection },
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
    if (rows.some(row => Object.keys(spec.sort).some(field => field !== '_id' && row[field] != null && !(row[field] instanceof Date)))) {
        return pageIds(collection, spec.query, spec, signal);
    }
    rows.sort((a, b) => compareRows(a, b, spec.sort));
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
    const resolving = resolveSearch(Model, program, input);
    const totalCount = await totalFor(Model, program, resolving instanceof Promise ? await resolving : resolving);
    signal?.throwIfAborted();
    return { totalCount };
}

async function selectIds(collection, selection, totalCount, signal) {
    const spec = selection;
    const { config, query, hint } = spec;
    const hasFilters = Object.keys(query).length > 0;
    let ids;
    if (totalCount !== null && (!totalCount || spec.skip >= totalCount)) ids = [];
    else {
        // Common filters usually match recent records. Stream a covered date-first
        // index and stop at a page instead of sorting hundreds of thousands of IDs.
        // A short trial budget protects rare/historical queries; those fall back
        // to their selective prefix index.
        if (!spec.skipTrial && (spec.sortField === config.date || spec.recentHint) && hasFilters && (totalCount === null || totalCount >= 1000) && spec.skip + selection.limit <= 2000 && !spec.filters.receivedYear) {
            const recentHint = spec.recentHint || (spec.filters.worksite || spec.filters.worksiteState ? indexNames.worksiteRecent : indexNames.recent);
            const stages = metadataStages(spec, query, recentHint, true);
            try {
                // The bounded window also fences MongoDB's optimizer: without
                // this stage it moves sort after computed filters and scans the
                // entire recent index before returning the first page.
                const window = Math.min(20000, Math.max(5000, (spec.skip + selection.limit) * 100));
                ids = await collection.aggregate([stages[0], { $sort: spec.sort }, { $limit: window }, stages[1], stages[2],
                    { $skip: spec.skip }, { $limit: selection.limit }, { $project: sortProjection(spec) }],
                { hint: recentHint, maxTimeMS: 500, signal }).toArray();
                if (ids.length < (totalCount === null ? selection.limit : Math.min(selection.limit, totalCount - spec.skip))) ids = undefined;
            } catch (error) {
                if (error.code !== 50 || signal?.aborted) throw error;
            }
        }
        if (!ids) ids = await (spec.branches ? locationPage(collection, selection, signal) : pageIds(collection, query, selection, signal, hint));
    }
    return ids;
}

async function searchCases(Model, program, input, { signal } = {}) {
    signal?.throwIfAborted();
    if (input.count !== undefined && !['deferred', 'exact'].includes(input.count)) throw badRequest('Invalid count mode');
    const resolving = resolveSearch(Model, program, input);
    const spec = resolving instanceof Promise ? await resolving : resolving;
    const { config, page, limit } = spec;
    const collection = Model.collection;
    const deferred = input.count === 'deferred';
    // Sorting only IDs + indexed sort values avoids fetching thousands of large
    // disclosure documents. Fetch the small projected page after sorting.
    const totalCount = deferred ? counts.peek(countKey(program, spec)) ?? null : await totalFor(Model, program, spec);
    signal?.throwIfAborted();
    // One extra ID answers whether Next is available without an exact total.
    const selection = deferred ? { ...spec, limit: limit + 1 } : spec;
    let ids = await sortedIds(collection, selection, totalCount, signal);
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
    const keyOf = row => row[config.company] || row[config.employer]?.toLowerCase();
    const profileSlug = await profileSlugs(Model.db?.db, cases.map(keyOf));
    for (const row of cases) {
        const key = keyOf(row);
        if (typeof key === 'string' && key) row.EMPLOYER_PROFILE_SLUG = profileSlug(key);
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
    const group = spec.employerGroup;
    return { cases, ...(group ? { employerGroup: { id: group.id, name: group.name, slug: group.slug, names: group.keys.length } } : {}), totalPages: knownTotal === null ? null : Math.ceil(knownTotal / limit), currentPage: page, totalCount: knownTotal,
        ...(deferred ? { hasNextPage } : {}) };
}

module.exports = { buildSearch, resolveSearch, resolveEmployerGroup, insensitivePrefix, searchCases, countCases, metadataStages,
    invalidateCounts: () => { counts.clear(); employerGroups.clear(); } };
