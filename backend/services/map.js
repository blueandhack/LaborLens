// Nationwide map of filings by worksite state and metro area, by program,
// year and occupation. A background refresh reduces every case collection to
// small summary documents; requests only read those documents.
const { programs, indexNames } = require('./searchConfig');
const { BoundedCache } = require('./boundedCache');
const geo = require('./geo');
const { hintFor } = require('./indexHints');

const MAP_VERSION = 1;
// County and city detail for the zoomed map (map_local, map_city_index).
const LOCAL_VERSION = 1;
// A state's detail gets its own document past this many rows; smaller states
// of the same slice share one. Cities beyond MAX_CITIES are counted, not listed.
const OWN_DOCUMENT_ROWS = 300, MAX_CITIES = 1500, CITY_ZIPS = 10, CITY_ZIP_MINIMUM = 10;
// Years summarized together in each scan of the reduced cells.
const YEAR_WINDOW = 3;
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
    wageCount() { let wages = 0; if (this.wages) for (const count of this.wages.values()) wages += count; return wages; }
    summary() {
        const known = this.levels[1] + this.levels[2] + this.levels[3] + this.levels[4];
        return [this.count, this.wageCount() >= MIN_SAMPLE ? geo.median(this.wages) : null,
            known >= MIN_SAMPLE ? Math.round((this.levels[3] + this.levels[4]) / known * 1000) / 1000 : null];
    }
}
// Counties and cities are many and mostly small: sparse wage histograms, and
// a city's ZIP codes.
class LocalPlace extends Place {
    add(count, level, bin, zip) {
        this.count += count;
        if (level) this.levels[level] += count;
        if (bin !== null && bin !== undefined) (this.wages ||= new Map()).set(bin, (this.wages.get(bin) || 0) + count);
        if (zip) (this.zips ||= new Map()).set(zip, (this.zips.get(zip) || 0) + count);
    }
    topZips() {
        if (!this.zips || this.count < CITY_ZIP_MINIMUM) return [];
        return [...this.zips].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).slice(0, CITY_ZIPS);
    }
}

// One state's counties and cities for one (occupation, year) slice.
class StateLocal {
    constructor() { this.total = 0; this.counties = new Map(); this.cities = new Map(); }
    add(location, count, level, bin) {
        this.total += count;
        for (const [places, key, zip] of [[this.counties, location.county], [this.cities, location.city, location.zip]]) {
            if (!key) continue;
            let place = places.get(key);
            if (!place) places.set(key, place = new LocalPlace());
            place.add(count, level, bin, zip);
        }
    }
    payload() {
        const order = (a, b) => b[1].count - a[1].count || (a[0] < b[0] ? -1 : 1);
        const cities = [...this.cities].sort(order);
        const listed = cities.slice(0, MAX_CITIES);
        return { total: this.total,
            counties: [...this.counties].sort(order).map(([fips, place]) => [fips, ...place.summary()]),
            cities: listed.map(([key, place]) => [key, ...place.summary(), place.topZips()]),
            otherCities: cities.length - listed.length,
            otherCityFilings: cities.slice(MAX_CITIES).reduce((sum, [, place]) => sum + place.count, 0) };
    }
}
// States' detail by year ('all' and each year) for one occupation.
class LocalSlices {
    constructor() { this.years = new Map(); }
    add(year, location, count, level, bin) {
        if (!location) return;
        for (const key of year ? ['all', year] : ['all']) {
            let states = this.years.get(key);
            if (!states) this.years.set(key, states = new Map());
            let state = states.get(location.state);
            if (!state) states.set(location.state, state = new StateLocal());
            state.add(location, count, level, bin);
        }
    }
    take(year) { const states = this.years.get(year); this.years.delete(year); return states; }
}

// Documents for one slice: large states alone, the rest together under ':*'.
function localDocuments(program, year, occupation, states, generation) {
    const base = `${program}:${year}:${occupation}`, shared = {}, documents = [];
    for (const [state, local] of [...states].sort((a, b) => a[0] < b[0] ? -1 : 1)) {
        const payload = local.payload();
        if (payload.counties.length + payload.cities.length > OWN_DOCUMENT_ROWS)
            documents.push({ _id: `${base}:${state}`, program, year, occupation, state, ...payload, generation, version: LOCAL_VERSION });
        else shared[state] = payload;
    }
    if (Object.keys(shared).length) documents.push({ _id: `${base}:*`, program, year, occupation, states: shared, generation, version: LOCAL_VERSION });
    return documents;
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
    if (!force && previous?.version === MAP_VERSION && previous.localVersion === LOCAL_VERSION
        && previous.source?.count === source.count && previous.source?.revision === source.revision) {
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
        await tmp.createIndex({ o: 1, y: 1 });
        const cellCount = await tmp.estimatedDocumentCount();
        await setStatus(db, program, { phase: 'Learning worksite cities', cells: cellCount });
        await onProgress({ event: 'map-cells', program, cells: cellCount });

        // 2. Learn worksite cities' metros, counties and map points from cases that also report a ZIP code.
        const cities = new geo.CityMetros(), places = new geo.CityPlaces();
        for await (const row of tmp.aggregate([{ $match: { z: { $ne: '' }, c: { $ne: '' } } },
            { $group: { _id: { s: '$s', c: '$c', z: '$z' }, n: { $sum: '$n' } } }], { allowDiskUse: true, signal })) {
            const { state, metro } = geo.locate({ s: row._id.s, z: row._id.z });
            if (state && metro) cities.learn(state, row._id.c, metro, row.n);
            if (state) places.learn(state, row._id.c, row._id.z, row.n);
        }
        cities.finish(); places.finish();

        // 3. Occupations: raw codes grouped by their SOC 2018 code.
        const raw = new Map();
        for await (const row of tmp.aggregate([{ $group: { _id: '$o', n: { $sum: '$n' } } }], { hint: { o: 1, y: 1 }, signal })) {
            const code = geo.occupationCode(row._id);
            if (!code || !geo.occupationTitle(code)) continue;
            const entry = raw.get(code) || { code, title: geo.occupationTitle(code), count: 0, raw: [] };
            entry.count += row.n; entry.raw.push(row._id); raw.set(code, entry);
        }
        const published = [...raw.values()].filter(entry => entry.count >= MIN_OCCUPATION)
            .sort((a, b) => b.count - a.count || a.code.localeCompare(b.code)).slice(0, MAX_OCCUPATIONS);

        const stats = db.collection('map_stats'), localStats = db.collection('map_local');
        const replaceAll = async (collection, documents) => {
            for (let start = 0; start < documents.length; start += 200)
                await collection.bulkWrite(documents.slice(start, start + 200).map(document => ({ replaceOne: { filter: { _id: document._id }, replacement: document, upsert: true } })), { ordered: false });
        };
        const write = slices => replaceAll(stats, [...slices.slices].map(([year, slice]) => slice.document(program, year, slices.occupation, generation)));
        let localDocumentCount = 0;
        const writeLocal = async (local, occupation, year) => {
            const states = local.take(year);
            if (!states) return;
            const documents = localDocuments(program, year, occupation, states, generation);
            localDocumentCount += documents.length;
            await replaceAll(localStats, documents);
        };
        await setStatus(db, program, { phase: 'Summarizing occupations', completed: 0, of: published.length });
        const all = new Slices(); all.occupation = 'all';
        const add = (slices, row, local) => {
            const location = geo.locate(row, cities), level = geo.wageLevel(row.l);
            slices?.add(row.y, location, row.n, level, row.b);
            all.add(row.y, location, row.n, level, row.b);
            local?.add(row.y, geo.locateLocal(row, places), row.n, level, row.b);
        };
        // 4. One pass per published occupation in year order, so each year's
        //    county and city detail is written as soon as it is complete.
        for (const [index, entry] of published.entries()) {
            signal?.throwIfAborted();
            const slices = new Slices(); slices.occupation = entry.code;
            const local = new LocalSlices();
            let year;
            for await (const row of tmp.find({ o: { $in: entry.raw } }, { signal, sort: { y: 1 }, hint: { o: 1, y: 1 }, allowDiskUse: true })) {
                if (row.y !== year) { if (year) await writeLocal(local, entry.code, year); year = row.y; }
                add(slices, row, local);
            }
            for (const key of [...local.years.keys()]) await writeLocal(local, entry.code, key);
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

        // 5. County and city detail for all occupations, a few years per scan.
        await setStatus(db, program, { phase: 'Summarizing counties and cities' });
        const years = [...all.slices.keys()].filter(year => year !== 'all').sort((a, b) => a - b);
        const local = new LocalSlices();
        for (const window of [[null], ...Array.from({ length: Math.ceil(years.length / YEAR_WINDOW) }, (_, i) => years.slice(i * YEAR_WINDOW, (i + 1) * YEAR_WINDOW))]) {
            signal?.throwIfAborted();
            for await (const row of tmp.find({ y: { $in: window } }, { signal, hint: { $natural: 1 } }))
                local.add(row.y, geo.locateLocal(row, places), row.n, geo.wageLevel(row.l), row.b);
            for (const year of window) if (year) await writeLocal(local, 'all', year);
        }
        await writeLocal(local, 'all', 'all');
        await localStats.deleteMany({ program, generation: { $ne: generation } });
        const index = new Map();
        for (const [id, name, county, x, y] of places.map.values()) {
            const [state, key] = [id.slice(0, id.indexOf('|')), id.slice(id.indexOf('|') + 1)];
            if (!index.has(state)) index.set(state, []);
            index.get(state).push([key, name, county, x, y]);
        }
        await replaceAll(db.collection('map_city_index'), [...index].map(([state, rows]) => ({ _id: `${program}:${state}`, program, state, cities: rows, generation })));
        await db.collection('map_city_index').deleteMany({ program, generation: { $ne: generation } });

        const yearTotals = [...all.slices].filter(([year]) => year !== 'all').map(([year, slice]) => ({ year, total: slice.total, located: slice.located }))
            .sort((a, b) => b.year - a.year);
        const overall = all.get('all');
        await db.collection('map_cities').replaceOne({ _id: program }, { _id: program, cities: cities.toJSON(), generation, updatedAt: new Date() }, { upsert: true });
        await meta.replaceOne({ _id: program }, { _id: program, version: MAP_VERSION, localVersion: LOCAL_VERSION, generation, source, years: yearTotals,
            localDocuments: localDocumentCount, cities: places.map.size,
            occupations: published.map(({ code, title, count }) => ({ code, title, count })),
            total: overall.total, located: overall.located,
            metroLocated: [...overall.places].filter(([key]) => key[0] === 'M').reduce((sum, [, place]) => sum + place.count, 0),
            updatedAt: new Date() }, { upsert: true });
        cache.clear(); cityCache.clear(); cityIndexCache.clear();
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
    await db.collection('map_local').createIndex({ program: 1, generation: 1 });
    await db.collection('map_city_index').createIndex({ program: 1, generation: 1 });
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

// Learned cities of one state for a program: key → [name, county, x, y].
// Keyed by the map build's generation, so a new build is used at once.
const cityIndexCache = new BoundedCache({ capacity: 40, ttlMs: 3600000 });
function cityIndex(db, program, state, generation) {
    return cityIndexCache.get(JSON.stringify([db.databaseName, program, state, generation || null]), async () => {
        const document = await db.collection('map_city_index').findOne({ _id: `${program}:${state}` }, { maxTimeMS: 2000 });
        return new Map((document?.cities || []).map(([key, ...rest]) => [key, rest]));
    });
}

function localParameters(input) {
    const parameters = mapParameters(input);
    const raw = input.state;
    if (typeof raw !== 'string' || !/^[A-Za-z]{2}$/.test(raw.trim()) || !geo.states.has(raw.trim().toUpperCase())) throw badRequest('Invalid state');
    return { ...parameters, state: raw.trim().toUpperCase() };
}

// Counties and cities of one state for the zoomed map.
async function getLocalMap(db, input = {}) {
    const { program, year, occupation, state } = localParameters(input);
    return cache.get(JSON.stringify(['local', db.databaseName, program, year, occupation, state]), async () => {
        const base = `${program}:${year}:${occupation}`;
        const meta = await db.collection('map_meta').findOne({ _id: program }, { projection: { updatedAt: 1, localVersion: 1, generation: 1 }, maxTimeMS: 2000 });
        const [documents, index] = await Promise.all([
            db.collection('map_local').find({ _id: { $in: [`${base}:${state}`, `${base}:*`] }, version: LOCAL_VERSION },
                { projection: { [`states.${state}`]: 1, total: 1, counties: 1, cities: 1, otherCities: 1, otherCityFilings: 1 }, maxTimeMS: 2000 }).toArray(),
            cityIndex(db, program, state, meta?.generation),
        ]);
        const payload = documents.find(document => document._id.endsWith(':' + state)) || documents.find(document => document.states)?.states?.[state];
        const result = { program, year, occupation, state, ready: meta?.localVersion === LOCAL_VERSION, updatedAt: meta?.updatedAt || null,
            total: payload?.total || 0, otherCities: payload?.otherCities || 0, otherCityFilings: payload?.otherCityFilings || 0, counties: [], cities: [] };
        if (!payload) return result;
        result.counties = payload.counties.flatMap(([fips, count, median, senior]) => {
            const county = geo.counties.get(fips);
            return county ? [{ fips, name: county.name, count, median, senior, x: county.x, y: county.y,
                perCapita: county.population ? Math.round(count / county.population * 1e7) / 100 : null }] : [];
        });
        result.cities = payload.cities.map(([key, count, median, senior, zips]) => {
            const [name, county, x, y] = index.get(key) || [geo.titleCase(key), null, null, null];
            return { key, name, county, x, y, count, median, senior,
                zips: (zips || []).map(([zip, n]) => { const place = geo.zipPlace(zip); return { zip, count: n, x: place?.x ?? null, y: place?.y ?? null }; }) };
        });
        return result;
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
    ], { hint: await hintFor(Model.collection, indexNames.company), maxTimeMS, allowDiskUse: false, signal, comment: 'laborlens-employer-places' });
    for await (const row of cursor) slice.add(geo.locate(row._id, cities), row.n, geo.wageLevel(row._id.l), row._id.b);
    const document = slice.document(program, 'all', 'all', null);
    return { total: document.total, located: document.located,
        metroLocated: document.metros.reduce((sum, row) => sum + row[1], 0),
        states: expandStates(document.states).map(({ code, name, count, median }) => ({ code, name, count, median })),
        metros: expandMetros(document.metros).slice(0, 150).map(({ code, name, state, x, y, count, median }) => ({ code, name, state, x, y, count, median })) };
}

module.exports = { MAP_VERSION, LOCAL_VERSION, MAP_PROGRAMS, refreshMap, refreshProgramMap, getMap, getMapOptions, getLocalMap, employerPlaces, mapParameters,
    localDocuments, LocalSlices, invalidateMap: () => { cache.clear(); cityCache.clear(); cityIndexCache.clear(); } };
