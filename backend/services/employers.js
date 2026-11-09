const { randomUUID } = require('node:crypto');
const { programs, indexNames } = require('./searchConfig');
const { fields: worksiteFields, stringExpression } = require('./worksites');
const { idFor, slugFor, searchKey, nameKey, NAME_VERSION, findIdentity, ensureIdentityIndexes } = require('./employerIdentity');
const VERSION = 1;
// Case links use the reported name's own slug; profile routes redirect any
// included name to its combined identity.
const profileSlugFor = key => slugFor(key);
const display = name => String(name ?? '').replace(/\s+/g, ' ').trim();
const programCounts = row => Object.fromEntries(Object.entries(row.programs || {}).filter(([, info]) => info?.count)
    .map(([program, info]) => [program, { count: info.count, updatedAt: info.updatedAt }]));
const publicEmployer = row => ({ id: row._id, key: row.key, slug: row.slug || slugFor(row.key), name: display(row.name),
    updatedAt: row.updatedAt, programs: programCounts(row), location: row.location || null,
    ...(row.keys?.length > 1 ? { groupId: row._id, groupName: display(row.name), names: row.keys.length } : {}) });
// Before an identity build includes a new name, it is its own identity.
const singleIdentity = row => ({ ...row, slug: slugFor(row.key), keys: [row.key] });
const cacheIdFor = identity => identity.keys?.length > 1 ? `${identity._id}:names:${identity.scope}` : identity._id;
const GROUPING_POLICY = 'Related companies and subsidiaries with different names (for example a separate “Services” or “Consulting” entity) are not included. Identical or normalized names can still belong to different legal entities; compare case addresses and source disclosures.';
let activeProfile = null;

async function identitiesReady(db) {
    return Boolean((await db.collection('discovery_state').findOne({ _id: 'employer_identities' }, { projection: { ready: 1 }, maxTimeMS: 1000 }))?.ready);
}

async function resolveIdentity(db, id) {
    const identity = await findIdentity(db, id);
    if (identity) return identity;
    const reported = await db.collection('employers').findOne({ _id: id }, { maxTimeMS: 1000 });
    return reported ? singleIdentity(reported) : null;
}

async function ensureEmployerIndexes(db) {
    await db.collection('employers').createIndex({ searchKey: 1, _id: 1 });
    await db.collection('employers').createIndex({ featured: 1, featuredRank: 1 });
    await db.collection('employers').createIndex({ 'programs.h1b.count': -1, _id: 1 });
    for (const program of ['h1b', 'perm', 'pwd']) await db.collection('employers').createIndex(
        { [`programs.${program}.count`]: -1, searchKey: 1, _id: 1 }, { name: `directory_${program}_v1` });
    await ensureIdentityIndexes(db);
}

const prefixPattern = value => new RegExp('^' + value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
const namePrefixes = value => [...new Set([searchKey(value), nameKey(value)].filter(Boolean))].map(prefixPattern);

async function listEmployers(db, input = {}) {
    const invalid = () => Object.assign(new Error('Invalid employer directory sort, query, or page'), { status: 400 });
    const sort = input.sort === undefined ? 'h1b_desc' : input.sort;
    const q = input.q === undefined ? '' : input.q;
    const page = input.page === undefined ? 1 : Number(input.page);
    const limit = 24;
    if (!['h1b_desc', 'perm_desc', 'pwd_desc', 'name_asc', 'name_desc'].includes(sort) || typeof q !== 'string' || q.length > 160 ||
        input.page !== undefined && typeof input.page !== 'string' || !Number.isSafeInteger(page) || page < 1 || page > 100000) throw invalid();
    // Rows are employer identities: every reported spelling of a name is counted once, together.
    const collection = db.collection(await identitiesReady(db) ? 'employer_identities' : 'employers');
    const combined = collection.collectionName === 'employer_identities';
    const prefixes = searchKey(q) ? namePrefixes(q) : [];
    const query = !prefixes.length ? {} : combined ? { searchKeys: { $in: prefixes } } : { searchKey: { $in: prefixes } };
    const program = sort.split('_')[0];
    const order = sort.startsWith('name_') ? { searchKey: sort === 'name_asc' ? 1 : -1, _id: sort === 'name_asc' ? 1 : -1 }
        : { [`programs.${program}.count`]: -1, searchKey: 1, _id: 1 };
    const projection = Object.fromEntries(Object.keys(order).map(field => [field, 1]));
    // Selective prefixes read the name index; browsing and very short prefixes
    // read the sorted index and stop after a page of matches.
    const hint = prefixes.length && combined && searchKey(q).length >= 3 ? { searchKeys: 1 } : sort.startsWith('name_') ? { searchKey: 1, _id: 1 } : `directory_${program}_v1`;
    const ids = await collection.find(query, { projection, hint, maxTimeMS: 5000, allowDiskUse: true })
        .sort(order).skip((page - 1) * limit).limit(limit + 1).toArray();
    const selected = ids.slice(0, limit);
    const rows = await collection.find({ _id: { $in: selected.map(row => row._id) } }, { maxTimeMS: 1000 }).toArray();
    const byId = new Map(rows.map(row => [row._id, row]));
    return { employers: selected.filter(row => byId.has(row._id)).map(row => publicEmployer(byId.get(row._id))), page, limit, hasNextPage: ids.length > limit, sort, query: q.trim() };
}

async function suggestions(db, input) {
    if (typeof input !== 'string' || input.length > 160) throw Object.assign(new Error('Invalid employer query'), { status: 400 });
    if (searchKey(input).length < 2) return [];
    const volume = row => Object.values(row.programs || {}).reduce((total, info) => total + (info?.count || 0), 0);
    const projection = { key: 1, name: 1, slug: 1, programs: 1, location: 1, keys: 1, updatedAt: 1 };
    // A bounded prefix-index read, never a DISTINCT over millions of filings.
    // Ranking by volume within the bounded candidates prefers substantive histories.
    const candidates = await identitiesReady(db)
        ? await db.collection('employer_identities').find({ searchKeys: { $in: namePrefixes(input) } }, { projection, maxTimeMS: 1000 })
            .hint({ searchKeys: 1 }).limit(200).toArray()
        : await db.collection('employers').find({ searchKey: { $in: namePrefixes(input) } }, { projection, maxTimeMS: 1000 })
            .sort({ searchKey: 1, _id: 1 }).limit(32).toArray();
    return candidates.sort((a, b) => volume(b) - volume(a) || display(a.name).localeCompare(display(b.name))).slice(0, 8).map(publicEmployer);
}

async function refreshDirectory(db, models, { signal, onProgress = () => {} } = {}) {
    await ensureEmployerIndexes(db);
    await db.collection('discovery_state').updateOne({ _id: 'employers' }, { $set: { building: true, startedAt: new Date() } }, { upsert: true });
    for (const [program, Model] of Object.entries(models)) {
        signal?.throwIfAborted();
        const config = programs[program], generation = randomUUID();
        const cursor = Model.collection.aggregate([
            { $match: { [config.company]: { $type: 'string', $ne: '' } } },
            { $project: { _id: 1, [config.company]: 1, [config.date]: 1 } },
            { $group: { _id: '$' + config.company, count: { $sum: 1 }, caseId: { $first: '$_id' } } },
        ], { hint: indexNames.company, allowDiskUse: true, maxTimeMS: 60 * 60 * 1000, batchSize: 250, signal,
            comment: 'laborlens-employer-directory' });
        let batch = [], processed = 0;
        async function flush() {
            if (!batch.length) return;
            const examples = await Model.collection.find({ _id: { $in: batch.map(row => row.caseId) } }, {
                projection: { [config.employer]: 1, [config.state]: 1, EMPLOYER_CITY: 1, EMP_CITY: 1 }, signal,
            }).toArray();
            const byId = new Map(examples.map(row => [String(row._id), row]));
            await db.collection('employers').bulkWrite(batch.map(row => {
                const example = byId.get(String(row.caseId)) || {};
                return { updateOne: { filter: { _id: idFor(row._id) }, update: { $set: {
                    key: row._id, slug: slugFor(row._id), name: example[config.employer] || row._id, searchKey: searchKey(row._id),
                    nameKey: nameKey(row._id), nameVersion: NAME_VERSION,
                    [`programs.${program}`]: { count: row.count, generation, updatedAt: new Date() },
                    location: [example.EMPLOYER_CITY || example.EMP_CITY, example[config.state]].filter(Boolean).join(', ') || null,
                    updatedAt: new Date(),
                } }, upsert: true } };
            }), { ordered: false });
            processed += batch.length; batch = [];
            await onProgress({ event: 'directory', program, employers: processed });
        }
        try { for await (const row of cursor) { batch.push(row); if (batch.length >= 250) await flush(); } await flush(); }
        finally { await cursor.close(); }
        // Only retire stale entries after this program's entire scan succeeded.
        await db.collection('employers').updateMany({ [`programs.${program}`]: { $exists: true }, [`programs.${program}.generation`]: { $ne: generation } }, { $unset: { [`programs.${program}`]: '' } });
        await db.collection('discovery_state').updateOne({ _id: 'employers' }, { $set: { [`programs.${program}`]: { employers: processed, updatedAt: new Date() } } });
    }
    await db.collection('employers').deleteMany({ programs: {} });
    await db.collection('discovery_state').updateOne({ _id: 'employers' }, { $set: { building: false, ready: true, updatedAt: new Date() } });
}

const wageFields = {
    h1b: ['WAGE_RATE_OF_PAY_FROM', 'WAGE_RATE_OF_PAY_TO', 'WAGE_UNIT_OF_PAY'],
    perm: ['JOB_OPP_WAGE_FROM', 'JOB_OPP_WAGE_TO', 'JOB_OPP_WAGE_PER'],
    pwd: ['PWD_WAGE_RATE', 'PWD_WAGE_RATE', 'PWD_UNIT_OF_PAY'],
};
function profilePipeline(program, key) {
    const config = programs[program], [from, to, period] = wageFields[program];
    const date = '$' + config.date;
    const validDate = { $and: [{ $eq: [{ $type: date }, 'date'] }, { $gte: [date, new Date('1901-01-01')] }, { $lt: [date, new Date('2100-01-01')] }] };
    const groupText = field => ({ $cond: [{ $eq: [{ $type: '$' + field }, 'string'] }, { $trim: { input: '$' + field } }, 'Not reported'] });
    const ranked = expression => [{ $group: { _id: expression, count: { $sum: 1 } } }, { $sort: { count: -1, _id: 1 } }, { $limit: 8 }];
    const projected = [config.date, config.state, 'EMPLOYER_CITY', 'EMP_CITY', 'JOB_TITLE', 'CASE_STATUS', from, to, period,
        ...worksiteFields[program].city, ...worksiteFields[program].state, '_DOL_SOURCE.url', '_DOL_SOURCE.filename', '_DOL_SOURCE.fiscalYear'];
    return [
        { $match: { [config.company]: Array.isArray(key) ? { $in: key } : key } },
        { $project: Object.fromEntries([...new Set(projected)].map(field => [field, 1])) },
        { $facet: {
            total: [{ $count: 'count' }],
            timeline: [{ $match: { $expr: validDate } }, { $group: { _id: { $year: date }, count: { $sum: 1 } } }, { $sort: { _id: 1 } }],
            statuses: ranked(groupText('CASE_STATUS')),
            jobs: ranked(groupText('JOB_TITLE')),
            employers: ranked({ city: groupText(program === 'perm' ? 'EMP_CITY' : 'EMPLOYER_CITY'), state: groupText(config.state) }),
            worksites: ranked({ city: stringExpression(worksiteFields[program].city), state: stringExpression(worksiteFields[program].state) }),
            wages: [
                { $match: { [from]: { $type: 'number', $gte: 0, $lte: 1e10 } } },
                { $group: { _id: { $toUpper: { $trim: { input: { $cond: [{ $eq: [{ $type: '$' + period }, 'string'] }, '$' + period, 'NOT REPORTED'] } } } },
                    count: { $sum: 1 }, minimum: { $min: '$' + from }, maximum: { $max: { $cond: [
                        { $and: [{ $isNumber: '$' + to }, { $gte: ['$' + to, '$' + from] }, { $lte: ['$' + to, 1e10] }] }, '$' + to, '$' + from,
                    ] } } } }, { $sort: { count: -1, _id: 1 } }, { $limit: 20 },
            ],
            sources: [{ $match: { '_DOL_SOURCE.url': { $regex: '^https://www\\.dol\\.gov/' } } },
                { $group: { _id: '$_DOL_SOURCE.url', filename: { $first: '$_DOL_SOURCE.filename' }, fiscalYear: { $first: '$_DOL_SOURCE.fiscalYear' }, count: { $sum: 1 } } },
                { $sort: { count: -1, _id: 1 } }, { $limit: 12 }],
        } },
    ];
}

// identity: an employer_identities document (or a single reported name).
async function computeProfile(db, models, identity, { maxTimeMS = 12000, signal } = {}) {
    if (!identity.keys) identity = singleIdentity(identity);
    const keys = identity.keys.length > 1 ? identity.keys : identity.keys[0];
    const summaries = {};
    for (const [program, info] of Object.entries(identity.programs || {})) {
        if (!info?.count || !models[program]) continue;
        const [summary] = await models[program].collection.aggregate(profilePipeline(program, keys), {
            hint: indexNames.company, maxTimeMS, allowDiskUse: false, signal, comment: 'laborlens-employer-profile',
        }).toArray();
        const recent = await models[program].collection.find({ [programs[program].company]: Array.isArray(keys) ? { $in: keys } : keys }, {
            projection: Object.fromEntries(programs[program].fields.map(field => [field, 1])), maxTimeMS: 2000, signal,
        }).sort({ [programs[program].date]: -1, _id: 1 }).hint(indexNames.company).limit(5).toArray();
        summaries[program] = { ...summary, totalCount: summary.total[0]?.count || 0, recent };
        delete summaries[program].total;
    }
    const snapshot = { _id: cacheIdFor(identity), version: VERSION, summaries, updatedAt: new Date() };
    await db.collection('employer_profiles').replaceOne({ _id: snapshot._id }, snapshot, { upsert: true });
    await db.collection('employer_profile_requests').deleteMany({ _id: { $in: [identity._id, ...identity.keys.map(idFor)] } });
    return snapshot;
}

async function getProfile(db, models, slug, { refresh = true } = {}) {
    if (typeof slug !== 'string' || !/^[a-z0-9-]+--[a-f0-9]{24}$/.test(slug) || slug.length > 110) return null;
    const identity = await resolveIdentity(db, slug.slice(-24));
    if (!identity) return null;
    const snapshot = await db.collection('employer_profiles').findOne({ _id: cacheIdFor(identity), version: VERSION }, { maxTimeMS: 1000 });
    const complete = Boolean(snapshot && Object.entries(identity.programs || {}).every(([program, info]) => !info?.count || snapshot.summaries[program]));
    const directory = await db.collection('discovery_state').findOne({ _id: 'employers' }, { projection: { ready: 1 }, maxTimeMS: 1000 });
    const ready = Boolean(complete && directory?.ready);
    if (refresh && (!complete || Date.now() - snapshot.updatedAt.getTime() > 24 * 60 * 60 * 1000)) {
        const request = await db.collection('employer_profile_requests').findOneAndUpdate({ _id: identity._id }, { $setOnInsert: { requestedAt: new Date() } }, { upsert: true, returnDocument: 'after' });
        if (!activeProfile && (!request.retryAfter || request.retryAfter <= new Date())) {
            activeProfile = identity._id;
            void computeProfile(db, models, identity).catch(async error => {
                console.error('Employer summary failed:', error.message);
                await db.collection('employer_profile_requests').updateOne({ _id: identity._id }, { $set: { retryAfter: new Date(Date.now() + 60000) } }).catch(() => {});
            })
                .finally(() => { activeProfile = null; });
        }
    }
    const summaries = Object.fromEntries(Object.entries(snapshot?.summaries || {}).filter(([program]) => identity.programs?.[program]?.count));
    const similarNames = (await suggestions(db, display(identity.name).slice(0, 160))).filter(row => row.id !== identity._id);
    const combined = identity.keys.length > 1;
    const reportedNames = combined ? (await db.collection('employers').find({ _id: { $in: identity.keys.map(idFor) } }, { maxTimeMS: 1000 }).toArray())
        .sort((a, b) => identity.keys.indexOf(a.key) - identity.keys.indexOf(b.key))
        .map(member => ({ id: member._id, key: member.key, name: display(member.name), location: member.location || null, programs: programCounts(member) })) : [];
    return { ...publicEmployer(identity), ready, summaries, similarNames, snapshotAt: snapshot?.updatedAt || null,
        ...(combined ? { reportedNames, grouping: { kind: identity.grouping?.kind || 'automatic', description: identity.grouping?.description || '',
            reason: identity.grouping?.reason || '', evidence: identity.grouping?.evidence || [], policy: GROUPING_POLICY } } : {}) };
}

async function clearEmployerProgram(db, program) {
    for (const name of ['employers', 'employer_identities']) {
        await db.collection(name).updateMany({ [`programs.${program}`]: { $exists: true } }, { $unset: { [`programs.${program}`]: '' } });
        await db.collection(name).deleteMany({ programs: {} });
    }
    await db.collection('employer_profiles').deleteMany({ [`summaries.${program}`]: { $exists: true } });
}

async function featuredEmployers(db, limit) {
    const collection = db.collection(await identitiesReady(db) ? 'employer_identities' : 'employers');
    return (await collection.find({ featured: true }, { maxTimeMS: 1000 }).sort({ featuredRank: 1 }).limit(limit).toArray())
        .map(row => row.keys ? row : singleIdentity(row));
}

async function refreshFeatured(db, models, { signal, maxProfiles = 20, onProgress = () => {} } = {}) {
    const collection = db.collection(await identitiesReady(db) ? 'employer_identities' : 'employers');
    const requested = await db.collection('employer_profile_requests').find().sort({ requestedAt: 1 }).limit(maxProfiles).toArray();
    const top = await collection.find({ 'programs.h1b.count': { $gt: 0 } }).sort({ 'programs.h1b.count': -1, _id: 1 }).limit(maxProfiles).toArray();
    const synthropic = await collection.find({ searchKey: 'synthropic inc' }).limit(3).toArray();
    const unique = new Map([...synthropic, ...top].map(row => [row._id, row.keys ? row : singleIdentity(row)]));
    const attempted = new Set(), featured = [];
    let rank = 0;
    for (const identity of unique.values()) {
        if (rank >= maxProfiles) break;
        signal?.throwIfAborted();
        attempted.add(identity._id);
        try { await computeProfile(db, models, identity, { signal, maxTimeMS: 120000 }); }
        catch (error) { signal?.throwIfAborted(); await onProgress({ event: 'profile-failed', employer: identity.name, error: error.message }); continue; }
        await collection.updateOne({ _id: identity._id }, { $set: { featured: true, featuredRank: rank++ } });
        featured.push(identity._id);
        await onProgress({ event: 'profile', employer: identity.name, completed: rank });
    }
    await collection.updateMany({ featured: true, _id: { $nin: featured } }, { $unset: { featured: '', featuredRank: '' } });
    for (const request of requested) {
        if (attempted.has(request._id)) continue;
        const identity = await resolveIdentity(db, request._id);
        if (identity) await computeProfile(db, models, identity, { signal, maxTimeMS: 120000 });
        else await db.collection('employer_profile_requests').deleteOne({ _id: request._id });
    }
}
module.exports = { idFor, slugFor, profileSlugFor, searchKey, publicEmployer, resolveIdentity, ensureEmployerIndexes, listEmployers, suggestions, refreshDirectory, profilePipeline, computeProfile, getProfile, refreshFeatured, featuredEmployers, clearEmployerProgram, cacheIdFor };
