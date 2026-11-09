const { createHash, randomUUID } = require('node:crypto');
const { groups: reviewedGroups, groupForQuery } = require('./employerGroups');

// Employer identities combine reported filing names that refer to the same
// employer. Two kinds of evidence are automatic:
//  1. Names that are identical after normalizing capitalization, punctuation,
//     spacing, diacritics and the spelling of a corporate suffix (Corp. vs
//     Corporation). The suffix itself must agree: an Inc. never merges with an LLC.
//  2. Names whose PERM/PWD filings report the same employer FEIN, as their
//     dominant FEIN, with a shared business ZIP code.
// Reviewed links from employerGroups.js add documented history (for example
// a former name used only before FEINs were disclosed).
const NAME_VERSION = 1;
const MAX_FEIN_NAMES = 6;      // A FEIN reported by more names is an umbrella (e.g. a university system).
const MAX_LINKED_NAMES = 12;   // Normalized names per identity joined by FEIN links.
const FEIN_SHARE = 0.6;        // A FEIN must dominate each linked name's FEIN-bearing filings.

const idFor = key => createHash('sha256').update(key).digest('hex').slice(0, 24);
const searchKey = name => (name.toLowerCase().match(/[\p{L}\p{N}]+/gu) || []).join(' ');
const slugFor = key => `${searchKey(key).replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 80) || 'employer'}--${idFor(key)}`;
const SYNONYMS = new Map([['corporation', 'corp'], ['incorporated', 'inc'], ['company', 'co'], ['limited', 'ltd'],
    ['private', 'pvt'], ['international', 'intl']]);
const letter = token => token.length === 1 && /\p{L}/u.test(token);

function nameKey(value) {
    const text = String(value ?? '').normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase()
        .replace(/['’`]/gu, '').replace(/&/g, ' and ');
    const tokens = [];
    for (const token of text.match(/[\p{L}\p{N}]+/gu) || []) {
        // U.S.A. / L.L.C. / N.A. become usa / llc / na, matching their unpunctuated spelling.
        if (letter(token) && tokens.length && tokens.at(-1).letters) tokens.at(-1).text += token;
        else tokens.push({ text: token, letters: letter(token) });
    }
    const words = tokens.map(token => SYNONYMS.get(token.text) || token.text);
    if (words[0] === 'the' && words.length > 1) words.shift();
    return words.join(' ') || searchKey(String(value ?? ''));
}

function normalizeFein(value) {
    const digits = String(value ?? '').replace(/\D/g, '');
    if (digits.length !== 9 || /^(\d)\1{8}$/.test(digits) || ['123456789', '987654321'].includes(digits)) return null;
    return digits;
}

// rows: [{ nameKey, fein, count, zips: [], caseId, program, name }] aggregated per (FEIN, reported name).
function feinLinks(rows) {
    const byName = new Map();
    for (const row of rows) {
        const fein = normalizeFein(row.fein);
        if (!fein || !row.nameKey) continue;
        const feins = byName.get(row.nameKey) || new Map();
        const entry = feins.get(fein) || { count: 0, zips: new Set(), examples: [] };
        entry.count += row.count;
        // Spreadsheet imports can store ZIP codes as numbers, dropping a leading zero.
        for (const zip of row.zips || []) if (/^\d{4,5}$/.test(zip)) entry.zips.add(zip.padStart(5, '0'));
        if (row.caseId && entry.examples.length < 2) entry.examples.push({ caseId: row.caseId, program: row.program, name: row.name });
        feins.set(fein, entry); byName.set(row.nameKey, feins);
    }
    const byFein = new Map();
    for (const [key, feins] of byName) {
        const total = [...feins.values()].reduce((sum, entry) => sum + entry.count, 0);
        for (const [fein, entry] of feins) if (entry.count / total >= FEIN_SHARE) {
            const list = byFein.get(fein) || [];
            list.push({ nameKey: key, ...entry }); byFein.set(fein, list);
        }
    }
    const links = [], umbrellas = [];
    for (const [fein, list] of byFein) {
        if (list.length < 2) continue;
        if (list.length > MAX_FEIN_NAMES) { umbrellas.push({ fein, names: list.length }); continue; }
        list.sort((a, b) => b.count - a.count || (a.nameKey < b.nameKey ? -1 : 1));
        const [anchor, ...others] = list;
        for (const other of others) {
            const zip = [...other.zips].find(value => anchor.zips.has(value));
            // Production data shows volume alone is not enough: unrelated employers
            // in other states can report one FEIN. A shared business ZIP is required.
            if (!zip) continue;
            links.push({ a: anchor.nameKey, b: other.nameKey, fein, zip, counts: [anchor.count, other.count],
                examples: [...anchor.examples.slice(0, 1), ...other.examples.slice(0, 1)] });
        }
    }
    // Strongest evidence first, so the cluster-size guard keeps the best links.
    links.sort((x, y) => Math.min(...y.counts) - Math.min(...x.counts) || (x.a + x.b < y.a + y.b ? -1 : 1));
    return { links, umbrellas };
}

class Clusters {
    constructor() { this.parent = new Map(); this.size = new Map(); }
    find(key) {
        let root = key;
        while (this.parent.has(root) && this.parent.get(root) !== root) root = this.parent.get(root);
        let node = key;
        while (this.parent.has(node) && this.parent.get(node) !== root) { const next = this.parent.get(node); this.parent.set(node, root); node = next; }
        return root;
    }
    union(a, b, limit = Infinity) {
        for (const key of [a, b]) if (!this.parent.has(key)) { this.parent.set(key, key); this.size.set(key, 1); }
        const [x, y] = [this.find(a), this.find(b)];
        if (x === y) return true;
        if (this.size.get(x) + this.size.get(y) > limit) return false;
        const [big, small] = this.size.get(x) >= this.size.get(y) ? [x, y] : [y, x];
        this.parent.set(small, big); this.size.set(big, this.size.get(x) + this.size.get(y)); this.size.delete(small);
        return true;
    }
    linked(key) { return this.parent.has(key) && this.size.get(this.find(key)) > 1; }
}

const total = programs => Object.values(programs || {}).reduce((sum, info) => sum + (info?.count || 0), 0);
const latest = programs => Math.max(0, ...Object.values(programs || {}).map(info => info?.latest instanceof Date && info.latest <= new Date() ? info.latest.getTime() : 0));
const RENAME_SHARE = 0.1;      // A name needs this share of an identity's filings to become its title.
const display = name => String(name).replace(/\s+/g, ' ').trim();
const feinEnding = fein => fein.slice(-4);
const programLabel = { h1b: 'H-1B', perm: 'PERM', pwd: 'PWD' };

// members: employer directory rows ({ _id, key, name, programs, location, nameKey }).
function describeIdentity(members, { links = [], reviewed = [] } = {}) {
    const reviewedGroup = reviewed[0];
    const sorted = [...members].sort((a, b) => total(b.programs) - total(a.programs) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
    // Linked names (a rename such as Facebook -> Meta Platforms) are titled by
    // the most recently used substantial name; spelling variants by volume.
    const byName = new Map();
    for (const member of sorted) {
        const key = member.nameKey || nameKey(member.key), entry = byName.get(key) || { members: [], total: 0, latest: 0 };
        entry.members.push(member); entry.total += total(member.programs); entry.latest = Math.max(entry.latest, latest(member.programs));
        byName.set(key, entry);
    }
    const clusterTotal = sorted.reduce((sum, member) => sum + total(member.programs), 0);
    const current = [...byName.values()].filter(entry => entry.total >= RENAME_SHARE * clusterTotal)
        .sort((a, b) => b.latest - a.latest || b.total - a.total)[0];
    const canonical = (reviewedGroup && sorted.find(member => member.key === reviewedGroup.key)) || current?.members[0] || sorted[0];
    const keys = sorted.map(member => member.key);
    const programs = {};
    for (const member of sorted) for (const [program, info] of Object.entries(member.programs || {})) {
        if (!info?.count) continue;
        programs[program] ||= { count: 0, updatedAt: info.updatedAt };
        programs[program].count += info.count;
        if (info.updatedAt > programs[program].updatedAt) programs[program].updatedAt = info.updatedAt;
    }
    const name = reviewedGroup?.name || display(canonical.name);
    const identity = {
        _id: idFor(canonical.key), key: canonical.key, name, slug: slugFor(canonical.key), searchKey: searchKey(canonical.key),
        searchKeys: [...new Set(sorted.flatMap(member => [searchKey(member.key), member.nameKey || nameKey(member.key)]).filter(Boolean))],
        keys, programs, total: total(programs), location: canonical.location || null,
        scope: createHash('sha256').update(JSON.stringify([...keys].sort())).digest('hex').slice(0, 16),
    };
    if (keys.length < 2) return identity;
    const nameGroups = new Map();
    for (const member of sorted) nameGroups.set(member.nameKey || nameKey(member.key), (nameGroups.get(member.nameKey || nameKey(member.key)) || 0) + 1);
    const spellings = [...nameGroups.values()].some(count => count > 1);
    const feinNames = links.map(link => {
        const names = [link.a, link.b].map(key => display(sorted.find(member => (member.nameKey || nameKey(member.key)) === key)?.name || key));
        return `${names[0]} and ${names[1]} report the same employer FEIN (ending ${feinEnding(link.fein)}) and business ZIP code ${link.zip}`;
    });
    const parts = [];
    if (reviewedGroup) parts.push(reviewedGroup.description);
    if (spellings) parts.push('Combines reported spellings that differ only in capitalization, punctuation, spacing, accents, or abbreviated corporate words such as Corp./Corporation, Inc./Incorporated and Ltd./Limited.');
    if (feinNames.length) parts.push('Also combines names linked by the employer identification number reported on PERM and prevailing wage filings.');
    const reasons = [];
    if (reviewedGroup) reasons.push(reviewedGroup.reason);
    if (feinNames.length) reasons.push(feinNames.join('; ') + '.');
    if (spellings) reasons.push('Spelling variants must normalize to the same name, including the same legal form (an Inc. never merges with an LLC).');
    const evidence = [...(reviewedGroup?.evidence || []), ...links.flatMap(link => link.examples.map(example => ({
        title: `${programLabel[example.program]}: ${display(example.name)} · FEIN ending ${feinEnding(link.fein)}`, url: `/cases/${example.caseId}`,
    })))].filter((item, index, list) => list.findIndex(other => other.url === item.url) === index).slice(0, 12);
    identity.grouping = {
        kind: reviewedGroup ? 'reviewed' : 'automatic', description: parts.join(' '), reason: reasons.join(' '), evidence,
        links: links.map(link => ({ names: [link.a, link.b], feinEnding: feinEnding(link.fein), zip: link.zip })),
    };
    return identity;
}

async function ensureIdentityIndexes(db) {
    await db.collection('employers').createIndex({ nameKey: 1, _id: 1 });
    await db.collection('employers').createIndex({ identity: 1 });
    const identities = db.collection('employer_identities');
    await identities.createIndex({ searchKey: 1, _id: 1 });
    await identities.createIndex({ searchKeys: 1 });
    await identities.createIndex({ featured: 1, featuredRank: 1 });
    await identities.createIndex({ generation: 1 });
    for (const program of ['h1b', 'perm', 'pwd']) await identities.createIndex(
        { [`programs.${program}.count`]: -1, searchKey: 1, _id: 1 }, { name: `directory_${program}_v1` });
}

async function backfillNameKeys(db, { signal } = {}) {
    let batch = [], updated = 0;
    const flush = async () => { if (batch.length) { await db.collection('employers').bulkWrite(batch, { ordered: false }); updated += batch.length; batch = []; } };
    const cursor = db.collection('employers').find({ $or: [{ nameVersion: { $ne: NAME_VERSION } }, { nameKey: { $exists: false } }] },
        { projection: { key: 1 }, batchSize: 1000, signal });
    try {
        for await (const row of cursor) {
            batch.push({ updateOne: { filter: { _id: row._id }, update: { $set: { nameKey: nameKey(row.key), nameVersion: NAME_VERSION } } } });
            if (batch.length >= 1000) await flush();
        }
        await flush();
    } finally { await cursor.close(); }
    return updated;
}

const feinSources = {
    perm: { fein: 'EMP_FEIN', zip: 'EMP_POSTCODE' },
    pwd: { fein: 'EMPLOYER_FEIN', zip: 'EMPLOYER_POSTAL_CODE' },
};
async function collectFeinRows(models, { signal } = {}) {
    const { programs } = require('./searchConfig');
    const rows = [];
    for (const [program, source] of Object.entries(feinSources)) {
        if (!models[program]) continue;
        signal?.throwIfAborted();
        const company = programs[program].company;
        // FEINs exist only on recent disclosures; a natural-order scan avoids
        // fetching every document through the company index.
        const cursor = models[program].collection.aggregate([
            { $match: { [source.fein]: { $type: 'string', $ne: '' } } },
            { $group: { _id: { fein: '$' + source.fein, name: '$' + company }, count: { $sum: 1 }, caseId: { $first: '$_id' },
                display: { $first: '$' + programs[program].employer },
                zips: { $addToSet: { $substrCP: [{ $toString: { $ifNull: ['$' + source.zip, ''] } }, 0, 5] } } } },
        ], { allowDiskUse: true, hint: { $natural: 1 }, maxTimeMS: 2 * 60 * 60 * 1000, signal, comment: 'laborlens-employer-identities' });
        try {
            for await (const row of cursor) {
                if (typeof row._id.name !== 'string' || !normalizeFein(row._id.fein)) continue;
                rows.push({ nameKey: nameKey(row._id.name), fein: row._id.fein, count: row.count, zips: row.zips.slice(0, 20),
                    caseId: String(row.caseId), program, name: row.display || row._id.name });
            }
        } finally { await cursor.close(); }
    }
    return rows;
}

async function refreshIdentities(db, models, { signal, onProgress = () => {} } = {}) {
    await ensureIdentityIndexes(db);
    const backfilled = await backfillNameKeys(db, { signal });
    await onProgress({ event: 'identity-names', backfilled });
    const { links, umbrellas } = feinLinks(await collectFeinRows(models, { signal }));
    const clusters = new Clusters();
    for (const group of reviewedGroups) for (const key of group.keys.slice(1)) clusters.union(nameKey(group.keys[0]), nameKey(key));
    const accepted = links.filter(link => clusters.union(link.a, link.b, MAX_LINKED_NAMES));
    await onProgress({ event: 'identity-links', fein: accepted.length, skipped: links.length - accepted.length, umbrellas: umbrellas.length });
    const reviewedByName = new Map(reviewedGroups.flatMap(group => group.keys.map(key => [nameKey(key), group])));
    const generation = randomUUID();
    const pending = new Map();
    let identityWrites = [], memberWrites = [], identities = 0, combined = 0;
    async function flush(force = false) {
        if (identityWrites.length && (force || identityWrites.length >= 500)) {
            await db.collection('employer_identities').bulkWrite(identityWrites, { ordered: false }); identityWrites = [];
        }
        if (memberWrites.length && (force || memberWrites.length >= 1000)) {
            await db.collection('employers').bulkWrite(memberWrites, { ordered: false }); memberWrites = [];
        }
    }
    async function emit(members) {
        const keys = new Set(members.map(member => member.nameKey));
        const reviewed = [...new Set([...keys].map(key => reviewedByName.get(key)).filter(Boolean))];
        const identityLinks = clusters.linked(members[0].nameKey) ? accepted.filter(link => keys.has(link.a) && keys.has(link.b)) : [];
        const identity = describeIdentity(members, { links: identityLinks, reviewed });
        const { grouping, ...fields } = identity;
        identityWrites.push({ updateOne: { filter: { _id: identity._id }, update: {
            $set: { ...fields, generation, updatedAt: new Date(), ...(grouping ? { grouping } : {}) }, ...(grouping ? {} : { $unset: { grouping: '' } }),
        }, upsert: true } });
        for (const member of members) if (member.identity !== identity._id || member.identitySlug !== identity.slug) {
            memberWrites.push({ updateOne: { filter: { _id: member._id }, update: { $set: { identity: identity._id, identitySlug: identity.slug } } } });
        }
        identities++; if (identity.keys.length > 1) combined++;
        await flush();
        if (identities % 50000 === 0) await onProgress({ event: 'identities', identities, combined });
    }
    const cursor = db.collection('employers').aggregate([
        { $project: { key: 1, name: 1, programs: 1, location: 1, nameKey: 1, identity: 1, identitySlug: 1 } },
        { $group: { _id: '$nameKey', members: { $push: '$$ROOT' } } },
    ], { allowDiskUse: true, batchSize: 500, maxTimeMS: 60 * 60 * 1000, signal, comment: 'laborlens-employer-identities' });
    try {
        for await (const row of cursor) {
            signal?.throwIfAborted();
            if (row._id && clusters.linked(row._id)) {
                const root = clusters.find(row._id);
                pending.set(root, [...(pending.get(root) || []), ...row.members]);
            } else await emit(row.members);
        }
    } finally { await cursor.close(); }
    for (const members of pending.values()) await emit(members);
    await flush(true);
    // Retire identities only after every name received its current identity.
    const retired = await db.collection('employer_identities').deleteMany({ generation: { $ne: generation } });
    await db.collection('discovery_state').updateOne({ _id: 'employer_identities' },
        { $set: { ready: true, identities, combined, feinLinks: accepted.length, updatedAt: new Date() } }, { upsert: true });
    await onProgress({ event: 'identities-ready', identities, combined, retired: retired.deletedCount });
    return { identities, combined, feinLinks: accepted.length };
}

const validId = value => typeof value === 'string' && /^[a-f0-9]{24}$/.test(value);
// Resolves an identity ID, or the ID of any reported name it includes.
async function findIdentity(db, id) {
    if (!validId(id)) return null;
    const identity = await db.collection('employer_identities').findOne({ _id: id }, { maxTimeMS: 1000 });
    if (identity) return identity;
    const member = await db.collection('employers').findOne({ _id: id }, { projection: { identity: 1 }, maxTimeMS: 1000 });
    return member?.identity ? db.collection('employer_identities').findOne({ _id: member.identity }, { maxTimeMS: 1000 }) : null;
}

// A typed, complete reviewed name keeps resolving to its whole identity.
async function identityForQuery(db, value) {
    const group = groupForQuery(value);
    if (!group) return null;
    return (await findIdentity(db, group.id)) || { _id: group.id, key: group.key, name: group.name, slug: slugFor(group.key), keys: group.keys };
}

async function profileSlugs(db, keys) {
    const ids = [...new Set(keys.filter(key => typeof key === 'string' && key).map(idFor))];
    const rows = ids.length && db ? await db.collection('employers').find({ _id: { $in: ids } }, { projection: { key: 1, identitySlug: 1 }, maxTimeMS: 1000 }).toArray() : [];
    const slugs = new Map(rows.filter(row => row.identitySlug).map(row => [row.key, row.identitySlug]));
    return key => slugs.get(key) || slugFor(key);
}

module.exports = { NAME_VERSION, idFor, searchKey, slugFor, nameKey, normalizeFein, feinLinks, Clusters, describeIdentity,
    ensureIdentityIndexes, backfillNameKeys, collectFeinRows, refreshIdentities, findIdentity, identityForQuery, profileSlugs };
