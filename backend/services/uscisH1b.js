// USCIS H-1B Employer Data Hub: first decisions on H-1B petitions, counted by
// fiscal year, petitioner (name, last four digits of its tax ID, mailing
// address) and two-digit NAICS industry. Archived files report initial and
// continuing totals; newer hub exports report six petition types, which are
// combined into the same two totals (USCIS's own grouping, see INITIAL).
const { nameKey, searchKey } = require('./employerIdentity');
const { BoundedCache } = require('./boundedCache');

const ROWS = 'uscis_h1b', EMPLOYERS = 'uscis_h1b_employers', STATE_ID = 'uscis_h1b';
const ZSTD = { wiredTiger: { configString: 'block_compressor=zstd' } };
const OFFICIAL_URL = year => `https://www.uscis.gov/sites/default/files/document/data/h1b_datahubexport-${year}.csv`;
const OFFICIAL_YEARS = Array.from({ length: 15 }, (_, i) => 2009 + i);
// The hub's public crosstab as CSV, one fiscal year at a time (its field name ends in three spaces).
const HUB_CSV_URL = year => `${process.env.USCIS_HUB_CSV || 'https://bigdataanalyticspub-sb.uscis.dhs.gov/views/H1BEmployerDataHub-Final/H1BPublic.csv'}?${encodeURIComponent('Fiscal Year   ')}=${year}`;
// The archived FY2023 file was published before the year ended: it has about a
// quarter of FY2022's initial approvals.
const PARTIAL_YEARS = { 2023: 'The archived FY2023 file covers only part of the fiscal year.' };
const PAGE_SIZE = 25, MIN_RATE_DECISIONS = 20;

const INDUSTRIES = [
    ['11', 'Agriculture, forestry, fishing and hunting', ['11']], ['21', 'Mining, quarrying, and oil and gas extraction', ['21']],
    ['22', 'Utilities', ['22']], ['23', 'Construction', ['23']], ['31-33', 'Manufacturing', ['31', '32', '33']],
    ['42', 'Wholesale trade', ['42']], ['44-45', 'Retail trade', ['44', '45']], ['48-49', 'Transportation and warehousing', ['48', '49']],
    ['51', 'Information', ['51']], ['52', 'Finance and insurance', ['52']], ['53', 'Real estate and rental and leasing', ['53']],
    ['54', 'Professional, scientific, and technical services', ['54']], ['55', 'Management of companies and enterprises', ['55']],
    ['56', 'Administrative, support, and waste management services', ['56']], ['61', 'Educational services', ['61']],
    ['62', 'Health care and social assistance', ['62']], ['71', 'Arts, entertainment, and recreation', ['71']],
    ['72', 'Accommodation and food services', ['72']], ['81', 'Other services (except public administration)', ['81']],
    ['92', 'Public administration', ['92']], ['99', 'Unknown industry', ['99']],
].map(([code, label, naics]) => ({ code, label, naics }));
const industryOf = naics => INDUSTRIES.find(industry => industry.naics.includes(naics))?.code || '99';

// ---------------------------------------------------------------- Parsing

const LEGACY = { initialApprovals: 'initial approval', initialDenials: 'initial denial', continuingApprovals: 'continuing approval', continuingDenials: 'continuing denial' };
const CATEGORIES = { newEmployment: 'new employment', newConcurrent: 'new concurrent', changeOfEmployer: 'change of employer',
    continuation: 'continuation', changeSameEmployer: 'change with same employer', amended: 'amended' };
// USCIS's initial/continuing grouping: matching the hub's FY2022 rows to the archived FY2022
// file, change-of-employer petitions are continuing and new concurrent ones initial.
const INITIAL = ['newEmployment', 'newConcurrent'];
const FIELDS = {
    fiscalYear: ['fiscal year'], employer: ['employer', 'employer name', 'employer petitioner name', 'petitioner name'],
    naics: ['naics', 'naics code', 'industry naics code'], taxId: ['tax id'], state: ['state', 'petitioner state'],
    city: ['city', 'petitioner city'], zip: ['zip', 'zip code', 'petitioner zip code'],
};
const header = value => (String(value).toLowerCase().match(/[a-z0-9]+/g) || []).map(word => ({ approvals: 'approval', denials: 'denial' })[word] || word).join(' ');

function decode(buffer) {
    if (buffer[0] === 0xff && buffer[1] === 0xfe) return buffer.toString('utf16le').slice(1);
    const text = buffer.toString('utf8');
    return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

const delimiterOf = line => (line.match(/\t/g) || []).length > (line.match(/,/g) || []).length ? '\t' : ',';

// Comma- or tab-separated (Tableau crosstab exports use tabs), with quoted fields.
function records(text, delimiter = delimiterOf(text.slice(0, text.search(/\r?\n|$/)))) {
    const rows = []; let row = [], field = '', quoted = false;
    for (let i = 0; i < text.length; i++) {
        const char = text[i];
        if (quoted) {
            if (char === '"' && text[i + 1] === '"') { field += '"'; i++; } else if (char === '"') quoted = false; else field += char;
        } else if (char === '"' && field === '') quoted = true;
        else if (char === delimiter) { row.push(field); field = ''; }
        else if (char === '\n' || char === '\r') {
            if (char === '\r' && text[i + 1] === '\n') i++;
            row.push(field); field = '';
            if (row.some(value => value !== '')) rows.push(row);
            row = [];
        } else field += char;
    }
    row.push(field);
    if (row.some(value => value !== '')) rows.push(row);
    return rows;
}

const count = value => {
    const number = Number(String(value ?? '').replace(/[,\s]/g, '') || 0);
    if (!Number.isFinite(number) || number < 0) throw new Error(`Invalid count "${value}"`);
    return Math.round(number);
};
const text = value => String(value ?? '').trim().replace(/\s+/g, ' ');
const fail = message => Object.assign(new Error(message), { status: 400 });

// Three layouts: archived files (initial/continuing columns), hub crosstabs (a
// column per petition type), and the hub's long CSV (one line per petition type,
// with "Measure Names" and "Measure Values").
function layoutOf(head) {
    const columns = head.map(header);
    const find = names => columns.findIndex(name => names.includes(name));
    const at = Object.fromEntries(Object.entries(FIELDS).map(([field, names]) => [field, find(names)]));
    const legacy = Object.fromEntries(Object.entries(LEGACY).map(([field, name]) => [field, find([name])]));
    const categories = Object.fromEntries(Object.entries(CATEGORIES).map(([field, name]) => [field, [find([name + ' approval']), find([name + ' denial'])]]));
    const measure = find(['measure names']), value = find(['measure values']);
    const format = measure >= 0 && value >= 0 ? 'long' : Object.values(categories).every(([approval, denial]) => approval >= 0 && denial >= 0) ? 'wide'
        : Object.values(legacy).every(index => index >= 0) ? 'legacy' : null;
    const missing = [...['fiscalYear', 'employer'].filter(field => at[field] < 0).map(field => FIELDS[field][0]),
        ...(!format ? ['initial/continuing approval and denial counts (or the six petition-type counts)'] : [])];
    if (missing.length) throw fail(`Not a USCIS H-1B Employer Data Hub export: missing ${missing.join(', ')}.`);
    // In the long layout, every column except the measure name and value identifies a row.
    return { at, legacy, categories, format, measure, value, keyColumns: columns.map((_, index) => index).filter(index => index !== measure && index !== value) };
}

// The petitioner fields of a line, or null for blank and grand-total lines.
function baseRow(values, at) {
    const fiscalYear = Number(text(values[at.fiscalYear]).replace(/^FY\s*/i, ''));
    if (!Number.isInteger(fiscalYear) || fiscalYear < 2000 || fiscalYear > 2100) {
        if (!text(values[at.fiscalYear]) || /total/i.test(values.join(' '))) return null;
        throw new Error(`Invalid fiscal year "${values[at.fiscalYear]}"`);
    }
    const employer = text(values[at.employer]);
    const naics = (text(values[at.naics]).match(/^\d{2}/) || ['99'])[0];
    const zip = text(values[at.zip]).match(/^\d{3,5}/)?.[0];
    const key = employer ? nameKey(employer) : null;
    return { fiscalYear, employer, nameKey: key, groupKey: key ? expanded(key) : null, searchKey: employer ? searchKey(employer) : null,
        naics, industry: industryOf(naics), taxId: at.taxId >= 0 ? text(values[at.taxId]) || null : null,
        state: at.state >= 0 ? text(values[at.state]).toUpperCase() || null : null, city: at.city >= 0 ? text(values[at.city]).toUpperCase() || null : null,
        zip: zip ? zip.padStart(5, '0') : null };
}

const MEASURES = new Map(Object.entries(CATEGORIES).flatMap(([field, name]) => [[name + ' approval', [field, 'approvals']], [name + ' denial', [field, 'denials']]]));
const CONTINUING = Object.keys(CATEGORIES).filter(field => !INITIAL.includes(field));
function withTotals(row) {
    const sum = (fields, key) => fields.reduce((total, field) => total + row.categories[field][key], 0);
    return Object.assign(row, { initialApprovals: sum(INITIAL, 'approvals'), initialDenials: sum(INITIAL, 'denials'),
        continuingApprovals: sum(CONTINUING, 'approvals'), continuingDenials: sum(CONTINUING, 'denials') });
}
const decisions = row => row.initialApprovals + row.initialDenials + row.continuingApprovals + row.continuingDenials;

// Accepts records one at a time (the header first); rows without decisions are dropped.
function createRowParser() {
    let layout = null, line = 1;
    const rows = [], groups = new Map();
    return {
        push(values) {
            if (!layout) { layout = layoutOf(values); return; }
            line++;
            try {
                if (layout.format === 'long') {
                    const key = layout.keyColumns.map(index => values[index] ?? '').join('\u0001');
                    let row = groups.get(key);
                    if (row === undefined) {
                        const base = baseRow(values, layout.at);
                        row = base && Object.assign(base, { categories: Object.fromEntries(Object.keys(CATEGORIES).map(field => [field, { approvals: 0, denials: 0 }])) });
                        groups.set(key, row);
                    }
                    if (!row) return;
                    const target = MEASURES.get(header(values[layout.measure]));
                    if (!target) throw new Error(`Unknown measure "${values[layout.measure]}"`);
                    row.categories[target[0]][target[1]] += count(values[layout.value]);
                    return;
                }
                const row = baseRow(values, layout.at);
                if (!row) return;
                if (layout.format === 'wide') {
                    row.categories = Object.fromEntries(Object.entries(layout.categories).map(([field, [approval, denial]]) => [field, { approvals: count(values[approval]), denials: count(values[denial]) }]));
                    withTotals(row);
                } else for (const [field, index] of Object.entries(layout.legacy)) row[field] = count(values[index]);
                if (decisions(row) > 0) rows.push(row);
            } catch (error) { throw fail(`Line ${line}: ${error.message}`); }
        },
        finish() {
            if (!layout) throw fail('The file is empty.');
            for (const row of groups.values()) if (row && decisions(withTotals(row)) > 0) rows.push(row);
            if (!rows.length) throw fail('The file has no data rows.');
            return { rows, format: layout.format === 'legacy' ? 'initial-continuing' : 'petition-types' };
        },
    };
}

function parseUscisFile(buffer) {
    const parser = createRowParser();
    for (const values of records(decode(buffer))) parser.push(values);
    return parser.finish();
}

// The same, line by line from a UTF-8 stream: hub exports are about 100 MB a year.
async function parseUscisStream(stream) {
    const readline = require('node:readline');
    const parser = createRowParser();
    let delimiter = null, pending = '';
    for await (let line of readline.createInterface({ input: stream, crlfDelay: Infinity })) {
        if (delimiter === null) { line = line.replace(/^\uFEFF/, ''); delimiter = delimiterOf(line); }
        pending = pending ? pending + '\n' + line : line;
        if ((pending.match(/"/g) || []).length % 2) continue; // A quoted field continues on the next line.
        for (const values of records(pending, delimiter)) parser.push(values);
        pending = '';
    }
    if (pending) for (const values of records(pending, delimiter)) parser.push(values);
    return parser.finish();
}

// ---------------------------------------------------------------- Import

async function ensureCollection(db, name) {
    if (!(await db.listCollections({ name }, { nameOnly: true }).toArray()).length) {
        await db.createCollection(name, { storageEngine: ZSTD, indexOptionDefaults: { storageEngine: ZSTD } }).catch(error => { if (error.code !== 48) throw error; });
    }
}

async function ensureUscisIndexes(db) {
    await ensureCollection(db, ROWS); await ensureCollection(db, EMPLOYERS);
    const rows = db.collection(ROWS), employers = db.collection(EMPLOYERS);
    await rows.createIndexes([{ key: { fiscalYear: 1, importId: 1 } }, { key: { state: 1, fiscalYear: 1 } }, { key: { industry: 1, fiscalYear: 1 } },
        { key: { groupKey: 1, fiscalYear: 1 } }, { key: { searchKey: 1 } }]);
    await employers.createIndexes([{ key: { approvals: -1, _id: 1 } }, { key: { initialApprovals: -1, _id: 1 } }, { key: { denials: -1, _id: 1 } },
        { key: { denialRate: -1, decisions: -1, _id: 1 } }, { key: { searchKey: 1, _id: 1 } }, { key: { 'link.id': 1 } }]);
}

const totalsOf = rows => rows.reduce((sum, row) => {
    for (const field of Object.keys(LEGACY)) sum[field] += row[field];
    return sum;
}, { initialApprovals: 0, initialDenials: 0, continuingApprovals: 0, continuingDenials: 0 });

// Replaces each fiscal year in the file. A file much smaller than the year it
// replaces is usually a filtered export, so it is refused unless allowed.
async function importUscisRows(db, rows, { source = null, allowSmaller = false, rebuild = true, onProgress = () => {} } = {}) {
    await ensureUscisIndexes(db);
    const collection = db.collection(ROWS), importId = new Date().toISOString() + ':' + Math.random().toString(36).slice(2, 8);
    const byYear = new Map();
    for (const row of rows) { if (!byYear.has(row.fiscalYear)) byYear.set(row.fiscalYear, []); byYear.get(row.fiscalYear).push(row); }
    for (const [fiscalYear, yearRows] of byYear) {
        const existing = await collection.countDocuments({ fiscalYear });
        if (!allowSmaller && existing && yearRows.length < existing / 2) throw Object.assign(new Error(`FY${fiscalYear} has ${yearRows.length.toLocaleString('en-US')} rows, under half of the ${existing.toLocaleString('en-US')} already imported. Export the complete fiscal year (no filters).`), { status: 400 });
    }
    const years = {};
    for (const [fiscalYear, yearRows] of [...byYear].sort((a, b) => a[0] - b[0])) {
        for (let i = 0; i < yearRows.length; i += 5000) await collection.insertMany(yearRows.slice(i, i + 5000).map(row => ({ ...row, importId })), { ordered: false });
        await collection.deleteMany({ fiscalYear, importId: { $ne: importId } });
        years[fiscalYear] = { rows: yearRows.length, ...totalsOf(yearRows), partial: Boolean(source?.archived && PARTIAL_YEARS[fiscalYear]),
            note: source?.archived ? PARTIAL_YEARS[fiscalYear] || null : null, source, importedAt: new Date() };
        await onProgress({ event: 'uscis-year', fiscalYear, rows: yearRows.length });
    }
    await db.collection('discovery_state').updateOne({ _id: STATE_ID }, { $set: Object.fromEntries(Object.entries(years).map(([year, value]) => [`years.${year}`, value])) }, { upsert: true });
    if (rebuild) await rebuildUscisEmployers(db, { onProgress });
    return years;
}

// Recalculates initial/continuing totals of rows that keep the six petition
// types (after a change to INITIAL), then each year's summary and the employers.
async function recomputeUscisTotals(db, { onProgress = () => {} } = {}) {
    const sum = (fields, key) => ({ $add: fields.map(field => `$categories.${field}.${key}`) });
    const result = await db.collection(ROWS).updateMany({ categories: { $exists: true } }, [{ $set: {
        initialApprovals: sum(INITIAL, 'approvals'), initialDenials: sum(INITIAL, 'denials'),
        continuingApprovals: sum(CONTINUING, 'approvals'), continuingDenials: sum(CONTINUING, 'denials') } }]);
    const years = await db.collection(ROWS).aggregate([{ $group: { _id: '$fiscalYear', ...Object.fromEntries(Object.keys(LEGACY).map(field => [field, { $sum: '$' + field }])) } }]).toArray();
    await db.collection('discovery_state').updateOne({ _id: STATE_ID }, { $set: Object.fromEntries(years.flatMap(({ _id, ...totals }) =>
        Object.entries(totals).map(([field, value]) => [`years.${_id}.${field}`, value]))) });
    await onProgress({ event: 'uscis-recomputed', rows: result.modifiedCount });
    return rebuildUscisEmployers(db, { onProgress });
}

// Older files cut names at about 34 characters. A cut name joins the longer
// name that starts with it: the only one, or one with 80% of their decisions.
async function mergeTruncatedNames(db, { onProgress = () => {} } = {}) {
    const rows = db.collection(ROWS);
    await rows.updateMany({ nameKey: { $type: 'string' }, $expr: { $ne: ['$groupKey', { $ifNull: ['$baseKey', '$groupKey'] }] } }, [{ $set: { groupKey: '$baseKey' } }]);
    // A cursor, not distinct(): hundreds of thousands of names approach the 16 MB reply limit.
    const weights = new Map((await rows.aggregate([{ $match: { groupKey: { $type: 'string', $ne: '' } } },
        { $group: { _id: '$groupKey', weight: { $sum: { $add: ['$initialApprovals', '$initialDenials', '$continuingApprovals', '$continuingDenials'] } } } }], { allowDiskUse: true }).toArray())
        .map(row => [row._id, row.weight]));
    const keys = [...weights.keys()].sort();
    const target = new Map();
    for (let i = 0; i < keys.length; i++) {
        const key = keys[i];
        if (key.length < TRUNCATED) continue;
        const longer = [];
        for (let j = i + 1; j < keys.length && keys[j].startsWith(key) && longer.length <= 20; j++) longer.push(keys[j]);
        if (!longer.length || longer.length > 20) continue;
        const total = longer.reduce((sum, name) => sum + weights.get(name), 0);
        const top = longer.reduce((best, name) => weights.get(name) > weights.get(best) ? name : best);
        if (longer.length === 1 || weights.get(top) >= 0.8 * total) target.set(key, top);
    }
    const resolve = key => { let next = key; for (let hops = 0; target.has(next) && hops < 5; hops++) next = target.get(next); return next; };
    const writes = [...target.keys()].map(key => ({ updateMany: { filter: { groupKey: key }, update: { $set: { groupKey: resolve(key), baseKey: key } } } }));
    for (let i = 0; i < writes.length; i += 1000) await rows.bulkWrite(writes.slice(i, i + 1000), { ordered: false });
    await onProgress({ event: 'uscis-merged-names', merged: target.size });
    return target.size;
}

// One document per normalized petitioner name, with its fiscal years. The
// displayed name and location are from its latest year's largest row.
async function rebuildUscisEmployers(db, { onProgress = () => {} } = {}) {
    await ensureUscisIndexes(db);
    await mergeTruncatedNames(db, { onProgress });
    const decisions = { $add: ['$initialApprovals', '$initialDenials', '$continuingApprovals', '$continuingDenials'] };
    const sums = Object.fromEntries(Object.keys(LEGACY).map(field => [field, { $sum: '$' + field }]));
    await db.collection(ROWS).aggregate([
        { $match: { groupKey: { $type: 'string', $ne: '' } } },
        { $set: { rowWeight: decisions, located: { $cond: [{ $and: ['$city', '$state'] }, 1, 0] } } },
        { $group: { _id: { k: '$groupKey', fy: '$fiscalYear' }, ...sums, nameKeys: { $addToSet: '$nameKey' },
            top: { $top: { sortBy: { located: -1, rowWeight: -1 }, output: { name: '$employer', searchKey: '$searchKey', city: '$city', state: '$state', industry: '$industry' } } },
            weight: { $sum: decisions } } },
        { $group: { _id: '$_id.k', ...sums, nameKeys: { $addToSet: '$nameKeys' }, years: { $push: { fiscalYear: '$_id.fy', initialApprovals: '$initialApprovals', initialDenials: '$initialDenials',
            continuingApprovals: '$continuingApprovals', continuingDenials: '$continuingDenials' } },
            latest: { $top: { sortBy: { '_id.fy': -1, weight: -1 }, output: '$top' } } } },
        { $set: { approvals: { $add: ['$initialApprovals', '$continuingApprovals'] }, denials: { $add: ['$initialDenials', '$continuingDenials'] } } },
        { $set: { decisions: { $add: ['$approvals', '$denials'] }, name: '$latest.name', searchKey: '$latest.searchKey', industry: '$latest.industry',
            location: { city: '$latest.city', state: '$latest.state' }, years: { $sortArray: { input: '$years', sortBy: { fiscalYear: 1 } } },
            nameKeys: { $setUnion: { $reduce: { input: '$nameKeys', initialValue: [], in: { $concatArrays: ['$$value', '$$this'] } } } } } },
        { $set: { denialRate: { $cond: [{ $gte: ['$decisions', MIN_RATE_DECISIONS] }, { $divide: ['$denials', '$decisions'] }, null] } } },
        { $unset: 'latest' },
        { $out: EMPLOYERS },
    ], { allowDiskUse: true }).toArray();
    const employers = await db.collection(EMPLOYERS).estimatedDocumentCount();
    await onProgress({ event: 'uscis-employers', employers });
    const linked = await linkUscisEmployers(db, { onProgress });
    const meta = await db.collection('discovery_state').findOneAndUpdate({ _id: STATE_ID },
        { $set: { employers, linked, states: (await db.collection(ROWS).distinct('state')).filter(Boolean).sort(), updatedAt: new Date() }, $inc: { revision: 1 } },
        { upsert: true, returnDocument: 'after' });
    cache.clear();
    return meta;
}

// Older files abbreviate names; these expansions only ever add a match, never change one.
const ABBREVIATIONS = { svcs: 'services', svc: 'service', solns: 'solutions', soln: 'solution', tech: 'technology', techs: 'technologies',
    sys: 'systems', syss: 'systems', mgmt: 'management', mgt: 'management', univ: 'university', ctr: 'center', ctrs: 'centers', assn: 'association',
    assoc: 'associates', hosp: 'hospital', med: 'medical', natl: 'national', amer: 'american', dept: 'department', grp: 'group', hlth: 'health',
    inst: 'institute', engrg: 'engineering', consltg: 'consulting', dev: 'development', mfg: 'manufacturing', fndn: 'foundation',
    labs: 'laboratories', pharm: 'pharmaceuticals', hldgs: 'holdings', ins: 'insurance', fin: 'financial', resrch: 'research', sci: 'sciences' };
const expanded = key => key.split(' ').map(word => ABBREVIATIONS[word] || word).join(' ');
const TRUNCATED = 30; // Older files cut names at about 34 characters.
const escape = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const filings = row => Object.values(row.programs || {}).reduce((sum, info) => sum + (info?.count || 0), 0);

// Links each USCIS petitioner name to a LaborLens employer name: identical
// after normalization, then after expanding abbreviations, then (for names cut
// short by the source) the only employer identity whose name starts with it.
async function linkUscisEmployers(db, { signal, onProgress = () => {} } = {}) {
    const employers = db.collection('employers'), uscis = db.collection(EMPLOYERS);
    if (!(await employers.estimatedDocumentCount())) return 0;
    const cursor = uscis.find({}, { projection: { link: 1, nameKeys: 1 }, batchSize: 2000, signal });
    let batch = [], linked = 0, checked = 0;
    const best = rows => rows.sort((a, b) => filings(b) - filings(a) || String(a._id).localeCompare(String(b._id)))[0];
    const flush = async () => {
        const candidates = row => [...new Set([...(row.nameKeys || []), row._id])];
        const keys = [...new Set(batch.flatMap(candidates))];
        const found = new Map();
        for (const row of await employers.find({ nameKey: { $in: keys } }, { projection: { nameKey: 1, programs: 1, identity: 1 }, maxTimeMS: 30000 }).toArray()) {
            found.set(row.nameKey, [...(found.get(row.nameKey) || []), row]);
        }
        const writes = [];
        for (const row of batch) {
            const exact = (row.nameKeys || []).flatMap(key => found.get(key) || []);
            let match = exact.length ? { row: best(exact), method: 'name' } : found.get(row._id) ? { row: best(found.get(row._id)), method: 'abbreviation' } : null;
            if (!match && row._id.length >= TRUNCATED) {
                const candidates = await employers.find({ nameKey: { $regex: '^' + escape(row._id) } }, { projection: { nameKey: 1, programs: 1, identity: 1 }, limit: 6, maxTimeMS: 5000 }).toArray();
                if (candidates.length && new Set(candidates.map(candidate => candidate.identity || candidate._id)).size === 1) match = { row: best(candidates), method: 'prefix' };
            }
            const link = match ? { id: match.row._id, method: match.method } : null;
            if (link) linked++;
            if (JSON.stringify(link) !== JSON.stringify(row.link || null)) writes.push({ updateOne: { filter: { _id: row._id }, update: link ? { $set: { link } } : { $unset: { link: '' } } } });
        }
        if (writes.length) await uscis.bulkWrite(writes, { ordered: false });
        checked += batch.length; batch = [];
        await onProgress({ event: 'uscis-links', checked, linked });
    };
    try {
        for await (const row of cursor) { batch.push(row); if (batch.length >= 2000) await flush(); }
        if (batch.length) await flush();
    } finally { await cursor.close(); }
    await db.collection('discovery_state').updateOne({ _id: STATE_ID }, { $set: { linked, linkedAt: new Date() } });
    cache.clear();
    return linked;
}

// ---------------------------------------------------------------- Reading

const cache = new BoundedCache({ capacity: 300, ttlMs: 10 * 60 * 1000 });
const invalid = message => Object.assign(new Error(message), { status: 400 });

async function meta(db) {
    const state = await db.collection('discovery_state').findOne({ _id: STATE_ID }, { maxTimeMS: 2000 });
    if (!state?.years) return null;
    return { revision: state.revision || 0, updatedAt: state.updatedAt || null, states: state.states || [], employers: state.employers || 0, linked: state.linked || 0,
        years: Object.entries(state.years).map(([year, value]) => ({ fiscalYear: Number(year), rows: value.rows, partial: Boolean(value.partial), note: value.note || null,
            source: value.source ? { name: value.source.name, url: value.source.url || null, official: Boolean(value.source.official) } : null, importedAt: value.importedAt }))
            .sort((a, b) => a.fiscalYear - b.fiscalYear) };
}

function filtersOf(input, info) {
    const fy = input.fy === undefined || input.fy === '' || input.fy === 'all' ? null : Number(input.fy);
    if (fy !== null && !info.years.some(year => year.fiscalYear === fy)) throw invalid('Unknown fiscal year');
    const state = input.state ? String(input.state).toUpperCase() : null;
    if (state && !info.states.includes(state)) throw invalid('Unknown state');
    const industry = input.industry ? String(input.industry) : null;
    if (industry && !INDUSTRIES.some(item => item.code === industry)) throw invalid('Unknown industry');
    const q = typeof input.q === 'string' ? input.q.trim() : '';
    if (q.length > 160 || input.q !== undefined && typeof input.q !== 'string') throw invalid('Invalid employer query');
    return { fy, state, industry, q };
}
const rowMatch = ({ fy, state, industry }) => ({ ...(fy !== null ? { fiscalYear: fy } : {}), ...(state ? { state } : {}), ...(industry ? { industry } : {}) });
const sumStage = Object.fromEntries(Object.keys(LEGACY).map(field => [field, { $sum: '$' + field }]));

async function getUscisOverview(db, input = {}) {
    const info = await meta(db);
    if (!info) return { available: false, industries: INDUSTRIES.map(({ code, label }) => ({ code, label })) };
    const filters = filtersOf(input, info);
    const trend = await cache.get(`trend|${info.revision}|${filters.state}|${filters.industry}`, () => db.collection(ROWS).aggregate([
        { $match: rowMatch({ ...filters, fy: null }) }, { $group: { _id: '$fiscalYear', ...sumStage } }, { $sort: { _id: 1 } },
    ], { maxTimeMS: 15000, allowDiskUse: true }).toArray());
    const years = new Map(info.years.map(year => [year.fiscalYear, year]));
    const series = trend.map(({ _id, ...row }) => ({ fiscalYear: _id, ...row, partial: Boolean(years.get(_id)?.partial) }));
    const selected = filters.fy === null ? series.filter(row => !row.partial || series.length === 1) : series.filter(row => row.fiscalYear === filters.fy);
    return { available: true, filters, years: info.years, states: info.states, industries: INDUSTRIES.map(({ code, label }) => ({ code, label })),
        trend: series, totals: totalsOf(selected), totalsExcludePartial: filters.fy === null && selected.length < series.length,
        employers: info.employers, linked: info.linked, updatedAt: info.updatedAt };
}

const SORTS = {
    approvals: { field: 'approvals', order: { approvals: -1, _id: 1 } }, initial: { field: 'initialApprovals', order: { initialApprovals: -1, _id: 1 } },
    denials: { field: 'denials', order: { denials: -1, _id: 1 } }, denialRate: { field: 'denialRate', order: { denialRate: -1, decisions: -1, _id: 1 } },
    name: { field: 'searchKey', order: { searchKey: 1, _id: 1 } },
};

async function listUscisEmployers(db, input = {}) {
    const info = await meta(db);
    if (!info) return { available: false, employers: [], page: 1, hasNextPage: false };
    const filters = filtersOf(input, info);
    const sort = input.sort || 'approvals', page = input.page === undefined ? 1 : Number(input.page);
    if (!SORTS[sort] || !Number.isSafeInteger(page) || page < 1 || page > 2000) throw invalid('Invalid sort or page');
    const prefixes = filters.q ? [...new Set([searchKey(filters.q), nameKey(filters.q)].filter(Boolean))].map(value => new RegExp('^' + escape(value))) : [];
    const skip = (page - 1) * PAGE_SIZE;
    const rows = await cache.get(`employers|${info.revision}|${JSON.stringify(filters)}|${sort}|${page}`, async () => {
        if (filters.fy === null && !filters.state && !filters.industry) {
            const query = { ...(prefixes.length ? { $or: [{ searchKey: { $in: prefixes } }, { _id: { $in: prefixes } }] } : {}), ...(sort === 'denialRate' ? { denialRate: { $ne: null } } : {}) };
            return db.collection(EMPLOYERS).find(query, { maxTimeMS: 8000 }).sort(SORTS[sort].order).skip(skip).limit(PAGE_SIZE + 1).toArray();
        }
        const decisions = { $add: ['$initialApprovals', '$initialDenials', '$continuingApprovals', '$continuingDenials'] };
        return db.collection(ROWS).aggregate([
            { $match: { ...rowMatch(filters), groupKey: { $type: 'string', $ne: '' }, ...(prefixes.length ? { $or: [{ searchKey: { $in: prefixes } }, { nameKey: { $in: prefixes } }] } : {}) } },
            { $set: { located: { $cond: [{ $and: ['$city', '$state'] }, 1, 0] } } },
            { $group: { _id: '$groupKey', ...sumStage, top: { $top: { sortBy: { located: -1, fiscalYear: -1 }, output: { name: '$employer', searchKey: '$searchKey', city: '$city', state: '$state', industry: '$industry' } } }, weight: { $sum: decisions } } },
            { $set: { approvals: { $add: ['$initialApprovals', '$continuingApprovals'] }, denials: { $add: ['$initialDenials', '$continuingDenials'] }, decisions: '$weight',
                name: '$top.name', searchKey: '$top.searchKey', industry: '$top.industry', location: { city: '$top.city', state: '$top.state' } } },
            { $set: { denialRate: { $cond: [{ $gte: ['$decisions', MIN_RATE_DECISIONS] }, { $divide: ['$denials', '$decisions'] }, null] } } },
            ...(sort === 'denialRate' ? [{ $match: { denialRate: { $ne: null } } }] : []),
            { $sort: SORTS[sort].order }, { $skip: skip }, { $limit: PAGE_SIZE + 1 }, { $unset: ['top', 'weight'] },
        ], { maxTimeMS: 15000, allowDiskUse: true }).toArray();
    });
    const shown = rows.slice(0, PAGE_SIZE);
    const links = await db.collection(EMPLOYERS).find({ _id: { $in: shown.map(row => row._id) }, link: { $exists: true } }, { projection: { link: 1 }, maxTimeMS: 2000 }).toArray();
    const slugs = await employerSlugs(db, links.map(row => row.link.id));
    const linkOf = new Map(links.map(row => [row._id, slugs.get(row.link.id)]));
    return { available: true, filters, sort, page, limit: PAGE_SIZE, hasNextPage: rows.length > PAGE_SIZE,
        employers: shown.map(row => ({ key: row._id, name: row.name || row._id, location: row.location, industry: row.industry,
            initialApprovals: row.initialApprovals, initialDenials: row.initialDenials, continuingApprovals: row.continuingApprovals, continuingDenials: row.continuingDenials,
            approvals: row.approvals, denials: row.denials, denialRate: row.denialRate, profile: linkOf.get(row._id) || null })) };
}

async function employerSlugs(db, ids) {
    const { slugFor } = require('./employerIdentity');
    if (!ids.length) return new Map();
    const rows = await db.collection('employers').find({ _id: { $in: ids } }, { projection: { key: 1, identitySlug: 1 }, maxTimeMS: 2000 }).toArray();
    return new Map(rows.map(row => [row._id, row.identitySlug || slugFor(row.key)]));
}

// USCIS decisions for an employer profile: every USCIS name linked to one of its filing names.
async function uscisForIdentity(db, ids) {
    const rows = await db.collection(EMPLOYERS).find({ 'link.id': { $in: ids } }, { maxTimeMS: 2000 }).sort({ decisions: -1 }).limit(40).toArray();
    if (!rows.length) return null;
    const info = await meta(db);
    const partial = new Set((info?.years || []).filter(year => year.partial).map(year => year.fiscalYear));
    const years = new Map();
    for (const row of rows) for (const year of row.years) {
        const entry = years.get(year.fiscalYear) || { fiscalYear: year.fiscalYear, initialApprovals: 0, initialDenials: 0, continuingApprovals: 0, continuingDenials: 0, partial: partial.has(year.fiscalYear) };
        for (const field of Object.keys(LEGACY)) entry[field] += year[field];
        years.set(year.fiscalYear, entry);
    }
    const series = [...years.values()].sort((a, b) => a.fiscalYear - b.fiscalYear);
    return { names: rows.map(row => ({ key: row._id, name: row.name, location: row.location, decisions: row.decisions, method: row.link.method })),
        years: series, totals: totalsOf(series), coverage: info ? { first: info.years[0]?.fiscalYear, last: info.years.at(-1)?.fiscalYear } : null };
}

async function getUscisStatus(db) {
    const info = await meta(db);
    const state = await db.collection('discovery_state').findOne({ _id: STATE_ID }, { projection: { job: 1 }, maxTimeMS: 2000 });
    return { ...(info || { years: [] }), job: state?.job || null };
}

module.exports = { parseCsv: records, decodeText: decode, ROWS, EMPLOYERS, STATE_ID, OFFICIAL_URL, OFFICIAL_YEARS, PARTIAL_YEARS, INDUSTRIES, industryOf, expanded,
    parseUscisFile, parseUscisStream, HUB_CSV_URL, importUscisRows, recomputeUscisTotals, rebuildUscisEmployers, linkUscisEmployers, ensureUscisIndexes,
    getUscisOverview, listUscisEmployers, uscisForIdentity, getUscisStatus, clearUscisCache: () => cache.clear() };
