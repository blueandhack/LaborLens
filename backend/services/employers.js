const { createHash, randomUUID } = require('node:crypto');
const { programs, indexNames } = require('./searchConfig');
const { fields: worksiteFields, stringExpression } = require('./worksites');
const { groupForKey, groupForQuery, cacheIdFor } = require('./employerGroups');
const VERSION = 1;
const idFor = key => createHash('sha256').update(key).digest('hex').slice(0, 24);
const searchKey = name => (name.toLowerCase().match(/[\p{L}\p{N}]+/gu) || []).join(' ');
const slugFor = key => `${searchKey(key).replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 80) || 'employer'}--${idFor(key)}`;
const profileSlugFor = key => slugFor(groupForKey(key)?.key || key);
const publicEmployer = row => ({ id: row._id, key: row.key, slug: profileSlugFor(row.key), name: row.name,
    updatedAt: row.updatedAt, programs: Object.fromEntries(Object.entries(row.programs || {}).map(([program, info]) => [program, { count: info.count, updatedAt: info.updatedAt }])), location: row.location || null,
    ...(groupForKey(row.key) ? { groupId: groupForKey(row.key).id, groupName: groupForKey(row.key).name } : {}) });
let activeProfile = null;

async function profileEmployer(db, row) {
    const group = groupForKey(row.key);
    if (!group) return row;
    const members = await db.collection('employers').find({ _id: { $in: group.keys.map(idFor) } }, { maxTimeMS: 1000 }).toArray();
    const canonical = members.find(member => member.key === group.key) || row;
    const programs = {};
    for (const member of members) for (const [program, info] of Object.entries(member.programs || {})) {
        programs[program] ||= { count: 0, updatedAt: info.updatedAt };
        programs[program].count += info.count;
        if (info.updatedAt > programs[program].updatedAt) programs[program].updatedAt = info.updatedAt;
    }
    return { ...canonical, _id: group.id, key: group.key, name: group.name, slug: slugFor(group.key), programs,
        groupId: group.id, groupKeys: group.keys,
        reportedNames: members.map(member => ({ id: member._id, key: member.key, name: member.name, location: member.location || null, programs: publicEmployer(member).programs })),
        grouping: { description: group.description, reason: group.reason, evidence: group.evidence } };
}

async function ensureEmployerIndexes(db) {
    await db.collection('employers').createIndex({ searchKey: 1, _id: 1 });
    await db.collection('employers').createIndex({ featured: 1, featuredRank: 1 });
    await db.collection('employers').createIndex({ 'programs.h1b.count': -1, _id: 1 });
    for (const program of ['h1b', 'perm', 'pwd']) await db.collection('employers').createIndex(
        { [`programs.${program}.count`]: -1, searchKey: 1, _id: 1 }, { name: `directory_${program}_v1` });
}

async function listEmployers(db, input = {}) {
    const invalid = () => Object.assign(new Error('Invalid employer directory sort, query, or page'), { status: 400 });
    const sort = input.sort === undefined ? 'h1b_desc' : input.sort;
    const q = input.q === undefined ? '' : input.q;
    const page = input.page === undefined ? 1 : Number(input.page);
    const limit = 24;
    if (!['h1b_desc', 'perm_desc', 'pwd_desc', 'name_asc', 'name_desc'].includes(sort) || typeof q !== 'string' || q.length > 160 ||
        input.page !== undefined && typeof input.page !== 'string' || !Number.isSafeInteger(page) || page < 1 || page > 100000) throw invalid();
    const prefix = searchKey(q), group = groupForQuery(q);
    const query = group ? { searchKey: { $in: [...new Set(group.keys.map(searchKey))] }, _id: { $in: group.keys.map(idFor) } }
        : prefix ? { searchKey: { $regex: '^' + prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') } } : {};
    const program = sort.split('_')[0];
    const order = sort.startsWith('name_') ? { searchKey: sort === 'name_asc' ? 1 : -1, _id: sort === 'name_asc' ? 1 : -1 }
        : { [`programs.${program}.count`]: -1, searchKey: 1, _id: 1 };
    const projection = Object.fromEntries(Object.keys(order).map(field => [field, 1]));
    const hint = sort.startsWith('name_') ? { searchKey: 1, _id: 1 } : `directory_${program}_v1`;
    const ids = await db.collection('employers').find(query, { projection, hint, maxTimeMS: 5000 })
        .sort(order).skip((page - 1) * limit).limit(limit + 1).toArray();
    const selected = ids.slice(0, limit);
    const rows = await db.collection('employers').find({ _id: { $in: selected.map(row => row._id) } }, { maxTimeMS: 1000 }).toArray();
    const byId = new Map(rows.map(row => [row._id, row]));
    return { employers: selected.filter(row => byId.has(row._id)).map(row => publicEmployer(byId.get(row._id))), page, limit, hasNextPage: ids.length > limit, sort, query: q.trim(),
        ...(group ? { employerGroup: { id: group.id, name: group.name } } : {}) };
}

async function suggestions(db, input) {
    if (typeof input !== 'string' || input.length > 160) throw Object.assign(new Error('Invalid employer query'), { status: 400 });
    const prefix = searchKey(input);
    if (prefix.length < 2) return [];
    // A bounded directory lookup, never a DISTINCT over millions of filings.
    const escaped = prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const candidates = await db.collection('employers').find({ searchKey: { $regex: '^' + escaped } },
        { maxTimeMS: 1000 }).sort({ searchKey: 1, _id: 1 }).limit(32).toArray();
    const directGroup = groupForQuery(input);
    if (directGroup && !candidates.some(candidate => groupForKey(candidate.key)?.id === directGroup.id)) {
        const canonical = await db.collection('employers').findOne({ _id: directGroup.id }, { maxTimeMS: 1000 });
        if (canonical) candidates.push(canonical);
    }
    const volume = row => Object.values(row.programs || {}).reduce((total, info) => total + info.count, 0);
    // Prefer substantive filing histories over tiny spelling variants, while
    // retaining distinct reported names and a bounded prefix-index read.
    const identities = new Map();
    for (const candidate of candidates) {
        const group = groupForKey(candidate.key), id = group?.id || candidate._id;
        if (!identities.has(id)) identities.set(id, group ? await profileEmployer(db, candidate) : candidate);
    }
    return [...identities.values()].sort((a, b) => volume(b) - volume(a) || a.name.localeCompare(b.name)).slice(0, 8).map(publicEmployer);
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

async function computeProfile(db, models, employer, { maxTimeMS = 12000, signal } = {}) {
    employer = await profileEmployer(db, employer);
    const keys = employer.groupKeys ? { $in: employer.groupKeys } : employer.key;
    const summaries = {};
    for (const [program, info] of Object.entries(employer.programs)) {
        if (!info.count || !models[program]) continue;
        const [summary] = await models[program].collection.aggregate(profilePipeline(program, employer.groupKeys || employer.key), {
            hint: indexNames.company, maxTimeMS, allowDiskUse: false, signal, comment: 'laborlens-employer-profile',
        }).toArray();
        const recent = await models[program].collection.find({ [programs[program].company]: keys }, {
            projection: Object.fromEntries(programs[program].fields.map(field => [field, 1])), maxTimeMS: 2000, signal,
        }).sort({ [programs[program].date]: -1, _id: 1 }).hint(indexNames.company).limit(5).toArray();
        summaries[program] = { ...summary, totalCount: summary.total[0]?.count || 0, recent };
        delete summaries[program].total;
    }
    const snapshot = { _id: cacheIdFor(employer), version: VERSION, summaries, updatedAt: new Date() };
    await db.collection('employer_profiles').replaceOne({ _id: snapshot._id }, snapshot, { upsert: true });
    await db.collection('employer_profile_requests').deleteMany({ _id: { $in: (employer.groupKeys || [employer.key]).map(idFor) } });
    return snapshot;
}

async function getProfile(db, models, slug, { refresh = true } = {}) {
    if (typeof slug !== 'string' || !/^[a-z0-9-]+--[a-f0-9]{24}$/.test(slug) || slug.length > 110) return null;
    const reported = await db.collection('employers').findOne({ _id: slug.slice(-24) }, { maxTimeMS: 1000 });
    if (!reported) return null;
    const employer = await profileEmployer(db, reported);
    const snapshot = await db.collection('employer_profiles').findOne({ _id: cacheIdFor(employer), version: VERSION }, { maxTimeMS: 1000 });
    const complete = Boolean(snapshot && Object.entries(employer.programs).every(([program, info]) => !info.count || snapshot.summaries[program]));
    const directory = await db.collection('discovery_state').findOne({ _id: 'employers' }, { projection: { ready: 1 }, maxTimeMS: 1000 });
    const ready = Boolean(complete && directory?.ready);
    if (refresh && (!complete || Date.now() - snapshot.updatedAt.getTime() > 24 * 60 * 60 * 1000)) {
        const request = await db.collection('employer_profile_requests').findOneAndUpdate({ _id: employer._id }, { $setOnInsert: { requestedAt: new Date() } }, { upsert: true, returnDocument: 'after' });
        if (!activeProfile && (!request.retryAfter || request.retryAfter <= new Date())) {
            activeProfile = employer._id;
            void computeProfile(db, models, employer).catch(async error => {
                console.error('Employer summary failed:', error.message);
                await db.collection('employer_profile_requests').updateOne({ _id: employer._id }, { $set: { retryAfter: new Date(Date.now() + 60000) } }).catch(() => {});
            })
                .finally(() => { activeProfile = null; });
        }
    }
    const summaries = Object.fromEntries(Object.entries(snapshot?.summaries || {}).filter(([program]) => employer.programs[program]?.count));
    const similarNames = (await suggestions(db, employer.name.slice(0, 160))).filter(row => row.id !== employer._id);
    return { ...publicEmployer(employer), ready, summaries, similarNames, snapshotAt: snapshot?.updatedAt || null,
        ...(employer.groupId ? { reportedNames: employer.reportedNames, grouping: employer.grouping } : {}) };
}

async function clearEmployerProgram(db, program) {
    await db.collection('employers').updateMany({ [`programs.${program}`]: { $exists: true } }, { $unset: { [`programs.${program}`]: '' } });
    await db.collection('employer_profiles').deleteMany({ [`summaries.${program}`]: { $exists: true } });
    await db.collection('employers').deleteMany({ programs: {} });
}

async function refreshFeatured(db, models, { signal, maxProfiles = 20, onProgress = () => {} } = {}) {
    const requested = await db.collection('employer_profile_requests').find().sort({ requestedAt: 1 }).limit(maxProfiles).toArray();
    const top = await db.collection('employers').find({ 'programs.h1b.count': { $gt: 0 } }).sort({ 'programs.h1b.count': -1, _id: 1 }).limit(maxProfiles).toArray();
    const synthropic = await db.collection('employers').find({ searchKey: 'synthropic inc' }).limit(3).toArray();
    const unique = new Map([...synthropic, ...top].map(row => [groupForKey(row.key)?.id || row._id, row]));
    const attempted = new Set();
    let rank = 0;
    for (const employer of unique.values()) {
        if (rank >= maxProfiles) break;
        signal?.throwIfAborted();
        attempted.add(employer._id);
        try { await computeProfile(db, models, employer, { signal, maxTimeMS: 120000 }); }
        catch (error) { signal?.throwIfAborted(); await onProgress({ event: 'profile-failed', employer: employer.name, error: error.message }); continue; }
        await db.collection('employers').updateOne({ _id: employer._id }, { $set: { featured: true, featuredRank: rank++ } });
        await onProgress({ event: 'profile', employer: employer.name, completed: rank });
    }
    for (const request of requested) {
        if (attempted.has(request._id)) continue;
        const employer = await db.collection('employers').findOne({ _id: request._id });
        if (employer) await computeProfile(db, models, employer, { signal, maxTimeMS: 120000 });
    }
}
module.exports = { idFor, slugFor, profileSlugFor, searchKey, publicEmployer, profileEmployer, ensureEmployerIndexes, listEmployers, suggestions, refreshDirectory, profilePipeline, computeProfile, getProfile, refreshFeatured, clearEmployerProgram, cacheIdFor };
