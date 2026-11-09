// Nationwide map of filings by worksite state and metro area, by program,
// year and occupation. A background refresh reduces every case collection to
// small summary documents; requests only read those documents.
const { programs, indexNames } = require('./searchConfig');
const { BoundedCache } = require('./boundedCache');
const geo = require('./geo');

const MAP_VERSION = 1;
const MIN_OCCUPATION = 50, MAX_OCCUPATIONS = 300;
// Medians and wage-level shares need enough cases to describe a place.
const MIN_SAMPLE = 10;
const MAP_PROGRAMS = ['h1b', 'perm', 'pwd'];
const cache = new BoundedCache({ capacity: 200, ttlMs: 300000 });
const badRequest = message => Object.assign(new Error(message), { status: 400 });

class Place {
    constructor() { this.count = 0; this.levels = [0, 0, 0, 0, 0]; this.wages = null; }
    add(count, level, bin) {
        this.count += count;
        if (level) this.levels[level] += count;
        if (bin !== null && bin !== undefined) (this.wages ||= geo.histogram())[bin] += count;
    }
    summary() {
        const known = this.levels[1] + this.levels[2] + this.levels[3] + this.levels[4];
        let wages = 0;
        if (this.wages) for (const count of this.wages) wages += count;
        return [this.count, wages >= MIN_SAMPLE ? geo.median(this.wages) : null,
            known >= MIN_SAMPLE ? Math.round((this.levels[3] + this.levels[4]) / known * 1000) / 1000 : null];
    }
}

// Places for one (occupation, year) slice, plus its case totals.
class Slice {
    constructor() { this.places = new Map(); this.total = 0; this.located = 0; }
    add(location, count, level, bin) {
        this.total += count;
        if (!location.state && !location.metro) return;
        this.located += count;
        for (const key of [location.state && 'S' + location.state, location.metro && 'M' + location.metro]) {
            if (!key) continue;
            let place = this.places.get(key);
            if (!place) this.places.set(key, place = new Place());
            place.add(count, level, bin);
        }
    }
    document(program, year, occupation, generation) {
        const states = [], metros = [];
        for (const [key, place] of this.places) (key[0] === 'S' ? states : metros).push([key.slice(1), ...place.summary()]);
        const order = (a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1);
        return { _id: `${program}:${year}:${occupation}`, program, year, occupation, total: this.total, located: this.located,
            states: states.sort(order), metros: metros.sort(order), generation, version: MAP_VERSION };
    }
}

class Slices {
    constructor() { this.slices = new Map(); }
    get(year) { let slice = this.slices.get(year); if (!slice) this.slices.set(year, slice = new Slice()); return slice; }
    add(year, location, count, level, bin) {
        this.get('all').add(location, count, level, bin);
        if (year) this.get(year).add(location, count, level, bin);
    }
}

// Build progress for the administration page: discovery_state "map".programs.<program>.
function setStatus(db, program, fields) {
    return db.collection('discovery_state').updateOne({ _id: 'map' }, { $set: Object.fromEntries(
        Object.entries({ ...fields, updatedAt: new Date() }).map(([key, value]) => [`programs.${program}.${key}`, value])) }, { upsert: true })
        .catch(error => console.error('Map status update failed:', error.message));
}

async function fingerprint(db, Model, program) {
    const [count, insights] = await Promise.all([Model.collection.estimatedDocumentCount(),
        db.collection('search_insights').findOne({ _id: program }, { projection: { revision: 1 } })]);
    return { count, revision: insights?.revision ?? null };
}

async function refreshProgramMap(db, Model, program, { generation, signal, onProgress = () => {}, force = false } = {}) {
    const config = programs[program], meta = db.collection('map_meta');
    const previous = await meta.findOne({ _id: program });
    const source = await fingerprint(db, Model, program);
    if (!force && previous?.version === MAP_VERSION && previous.source?.count === source.count && previous.source?.revision === source.revision) {
        await setStatus(db, program, { state: 'unchanged', phase: null, checkedAt: new Date() });
        await onProgress({ event: 'map-unchanged', program });
        return { program, unchanged: true };
    }
    const tmp = db.collection(`map_cells_${program}_tmp`);
    await tmp.drop().catch(() => {});
    const startedAt = new Date();
    await setStatus(db, program, { state: 'building', phase: 'Reducing cases to worksite cells', startedAt, checkedAt: startedAt,
        finishedAt: null, error: null, cells: null, completed: null, of: null, cases: source.count });
    try {
        // 1. Reduce cases to distinct (ZIP, city, state, year, occupation, level, wage bin) cells.
        const projection = geo.cellProjection(program, config.date);
        await Model.collection.aggregate([
            { $project: { _id: 0, ...projection } },
            { $group: { _id: Object.fromEntries(Object.keys(projection).map(key => [key, '$' + key])), n: { $sum: 1 } } },
            { $project: { _id: 0, ...Object.fromEntries(Object.keys(projection).map(key => [key, '$_id.' + key])), n: 1 } },
            { $out: tmp.collectionName },
        ], { allowDiskUse: true, hint: { $natural: 1 }, signal, comment: 'laborlens-map-cells' }).toArray();
        signal?.throwIfAborted();
        await tmp.createIndex({ o: 1 });
        const cellCount = await tmp.estimatedDocumentCount();
        await setStatus(db, program, { phase: 'Learning worksite cities', cells: cellCount });
        await onProgress({ event: 'map-cells', program, cells: cellCount });

        // 2. Learn worksite cities' metros from cases that also report a ZIP code.
        const cities = new geo.CityMetros();
        for await (const row of tmp.aggregate([{ $match: { z: { $ne: '' }, c: { $ne: '' } } },
            { $group: { _id: { s: '$s', c: '$c', z: '$z' }, n: { $sum: '$n' } } }], { allowDiskUse: true, signal })) {
            const { state, metro } = geo.locate({ s: row._id.s, z: row._id.z });
            if (state && metro) cities.learn(state, row._id.c, metro, row.n);
        }
        cities.finish();

        // 3. Occupations: raw codes grouped by their SOC 2018 code.
        const raw = new Map();
        for await (const row of tmp.aggregate([{ $group: { _id: '$o', n: { $sum: '$n' } } }], { hint: { o: 1 }, signal })) {
            const code = geo.occupationCode(row._id);
            if (!code || !geo.occupationTitle(code)) continue;
            const entry = raw.get(code) || { code, title: geo.occupationTitle(code), count: 0, raw: [] };
            entry.count += row.n; entry.raw.push(row._id); raw.set(code, entry);
        }
        const published = [...raw.values()].filter(entry => entry.count >= MIN_OCCUPATION)
            .sort((a, b) => b.count - a.count || a.code.localeCompare(b.code)).slice(0, MAX_OCCUPATIONS);

        const stats = db.collection('map_stats');
        const write = async slices => {
            const documents = [...slices.slices].map(([year, slice]) => slice.document(program, year, slices.occupation, generation));
            if (documents.length) await stats.bulkWrite(documents.map(document => ({ replaceOne: { filter: { _id: document._id }, replacement: document, upsert: true } })), { ordered: false });
        };
        await setStatus(db, program, { phase: 'Summarizing occupations', completed: 0, of: published.length });
        const all = new Slices(); all.occupation = 'all';
        const add = (slices, row) => {
            const location = geo.locate(row, cities), level = geo.wageLevel(row.l);
            slices?.add(row.y, location, row.n, level, row.b);
            all.add(row.y, location, row.n, level, row.b);
        };
        // 4. One pass per published occupation, then every remaining cell.
        for (const [index, entry] of published.entries()) {
            signal?.throwIfAborted();
            const slices = new Slices(); slices.occupation = entry.code;
            for await (const row of tmp.find({ o: { $in: entry.raw } }, { signal })) add(slices, row);
            await write(slices);
            if (index % 25 === 0) {
                await setStatus(db, program, { completed: index + 1 });
                await onProgress({ event: 'map-occupations', program, completed: index + 1, of: published.length });
            }
        }
        await setStatus(db, program, { phase: 'Summarizing all filings', completed: published.length });
        for await (const row of tmp.find({ o: { $nin: published.flatMap(entry => entry.raw) } }, { signal })) add(null, row);
        await write(all);
        await stats.deleteMany({ program, generation: { $ne: generation } });

        const years = [...all.slices].filter(([year]) => year !== 'all').map(([year, slice]) => ({ year, total: slice.total, located: slice.located }))
            .sort((a, b) => b.year - a.year);
        const overall = all.get('all');
        await db.collection('map_cities').replaceOne({ _id: program }, { _id: program, cities: cities.toJSON(), generation, updatedAt: new Date() }, { upsert: true });
        await meta.replaceOne({ _id: program }, { _id: program, version: MAP_VERSION, generation, source, years,
            occupations: published.map(({ code, title, count }) => ({ code, title, count })),
            total: overall.total, located: overall.located,
            metroLocated: [...overall.places].filter(([key]) => key[0] === 'M').reduce((sum, [, place]) => sum + place.count, 0),
            updatedAt: new Date() }, { upsert: true });
        cache.clear(); cityCache.clear();
        await setStatus(db, program, { state: 'ready', phase: null, finishedAt: new Date(), durationMs: Date.now() - startedAt.getTime() });
        await onProgress({ event: 'map-ready', program, total: overall.total, located: overall.located, occupations: published.length });
        return { program, total: overall.total, located: overall.located };
    } catch (error) {
        await setStatus(db, program, { state: 'failed', phase: null, finishedAt: new Date(), error: String(error?.message || error).slice(0, 500) });
        throw error;
    } finally {
        await tmp.drop().catch(() => {});
    }
}

async function refreshMap(db, models, { signal, onProgress, force = false, only } = {}) {
    await db.collection('map_stats').createIndex({ program: 1, generation: 1 });
    const generation = new Date().toISOString();
    const results = [];
    for (const program of MAP_PROGRAMS) {
        if (only && !only.includes(program)) continue;
        if (!models[program]) continue;
        results.push(await refreshProgramMap(db, models[program], program, { generation, signal, onProgress, force }));
    }
    return results;
}

function expandStates(rows) {
    return rows.flatMap(([code, count, median, senior]) => {
        const state = geo.states.get(code);
        return state ? [{ code, name: state.name, count, median, senior,
            perCapita: state.population ? Math.round(count / state.population * 1e7) / 100 : null }] : [];
    });
}
function expandMetros(rows) {
    return rows.flatMap(([code, count, median, senior]) => {
        const metro = geo.metros.get(code);
        return metro ? [{ code, name: metro.name, type: metro.type, state: metro.state, x: metro.x, y: metro.y, count, median, senior,
            perCapita: metro.population ? Math.round(count / metro.population * 1e7) / 100 : null }] : [];
    });
}

function mapParameters(input) {
    const value = field => { const raw = input[field]; if (raw !== undefined && typeof raw !== 'string') throw badRequest(`Invalid ${field}`); return (raw || '').trim(); };
    const program = value('program') || 'h1b', year = value('year') || 'all', occupation = value('occupation') || 'all';
    if (!MAP_PROGRAMS.includes(program)) throw badRequest('Invalid program');
    if (year !== 'all' && !/^(?:19|20)\d{2}$/.test(year)) throw badRequest('Invalid year');
    if (occupation !== 'all' && !/^\d{2}-\d{4}$/.test(occupation)) throw badRequest('Invalid occupation');
    return { program, year: year === 'all' ? 'all' : Number(year), occupation };
}

async function getMapOptions(db, input = {}) {
    const { program } = mapParameters({ program: input.program });
    return cache.get(JSON.stringify(['options', db.databaseName, program]), async () => {
        const meta = await db.collection('map_meta').findOne({ _id: program }, { maxTimeMS: 2000 });
        if (!meta) return { program, ready: false, years: [], occupations: [] };
        return { program, ready: true, updatedAt: meta.updatedAt, total: meta.total, located: meta.located, metroLocated: meta.metroLocated,
            years: meta.years, occupations: meta.occupations };
    });
}

async function getMap(db, input = {}) {
    const { program, year, occupation } = mapParameters(input);
    return cache.get(JSON.stringify(['map', db.databaseName, program, year, occupation]), async () => {
        const [document, meta] = await Promise.all([
            db.collection('map_stats').findOne({ _id: `${program}:${year}:${occupation}`, version: MAP_VERSION }, { maxTimeMS: 2000 }),
            db.collection('map_meta').findOne({ _id: program }, { projection: { updatedAt: 1 }, maxTimeMS: 2000 }),
        ]);
        const base = { program, year, occupation, occupationTitle: occupation === 'all' ? null : geo.occupationTitle(occupation),
            ready: Boolean(meta), updatedAt: meta?.updatedAt || null };
        if (!document) return { ...base, total: 0, located: 0, states: [], metros: [] };
        return { ...base, total: document.total, located: document.located, states: expandStates(document.states), metros: expandMetros(document.metros) };
    });
}

// Learned city → metro assignments for a program, cached for profile requests.
const cityCache = new BoundedCache({ capacity: 6, ttlMs: 3600000 });
function cityMetros(db, program) {
    return cityCache.get(JSON.stringify([db.databaseName, program]), async () => {
        const document = await db.collection('map_cities').findOne({ _id: program }, { maxTimeMS: 2000 });
        return new geo.CityMetros(document?.cities || {});
    });
}

// Where one employer's filings for a program are located: metros and states.
async function employerPlaces(db, Model, program, keys, { maxTimeMS = 12000, signal } = {}) {
    const config = programs[program], projection = geo.cellProjection(program, null);
    const cities = await cityMetros(db, program);
    const slice = new Slice();
    const cursor = Model.collection.aggregate([
        { $match: { [config.company]: Array.isArray(keys) ? { $in: keys } : keys } },
        { $project: { _id: 0, ...projection } },
        { $group: { _id: Object.fromEntries(Object.keys(projection).map(key => [key, '$' + key])), n: { $sum: 1 } } },
    ], { hint: indexNames.company, maxTimeMS, allowDiskUse: false, signal, comment: 'laborlens-employer-places' });
    for await (const row of cursor) slice.add(geo.locate(row._id, cities), row.n, geo.wageLevel(row._id.l), row._id.b);
    const document = slice.document(program, 'all', 'all', null);
    return { total: document.total, located: document.located,
        metroLocated: document.metros.reduce((sum, row) => sum + row[1], 0),
        states: expandStates(document.states).map(({ code, name, count, median }) => ({ code, name, count, median })),
        metros: expandMetros(document.metros).slice(0, 150).map(({ code, name, state, x, y, count, median }) => ({ code, name, state, x, y, count, median })) };
}

module.exports = { MAP_VERSION, MAP_PROGRAMS, refreshMap, refreshProgramMap, getMap, getMapOptions, employerPlaces, mapParameters,
    invalidateMap: () => { cache.clear(); cityCache.clear(); } };
