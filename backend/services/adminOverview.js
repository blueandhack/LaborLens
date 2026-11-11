// Everything the administration overview shows: datasets, database and server
// health, background jobs, backups, recent activity and account security.
const os = require('node:os');
const fs = require('node:fs/promises');
const { programs } = require('./searchConfig');
const { BoundedCache } = require('./boundedCache');
const { recentAdminEvents } = require('./adminEvents');

const PROGRAMS = ['pwd', 'perm', 'h1b'];
const LABELS = { pwd: 'PWD', perm: 'PERM', h1b: 'H-1B LCA' };
const cache = new BoundedCache({ capacity: 10, ttlMs: 600000 });
const quietly = (promise, fallback = null) => promise.catch(error => { console.error('Admin overview:', error.message); return fallback; });

// Newest decision or determination date, through the date index.
function newestCase(db, program) {
    const { collection, date } = programs[program];
    return cache.get(JSON.stringify(['newest', db.databaseName, program]), async () => {
        const [row] = await db.collection(collection).find({ [date]: { $type: 'date', $lte: new Date(Date.now() + 366 * 86400000) } },
            { projection: { _id: 0, [date]: 1 }, sort: { [date]: -1 }, limit: 1, maxTimeMS: 5000 }).toArray();
        return row?.[date] || null;
    });
}

const latestOf = (rows, field) => rows.reduce((latest, row) => row[field] instanceof Date && (!latest || row[field] > latest) ? row[field] : latest, null);

async function dataset(db, program) {
    const sources = db.collection('import_sources');
    const [count, newest, latest, checked, map] = await Promise.all([
        db.collection(programs[program].collection).estimatedDocumentCount(),
        quietly(newestCase(db, program)),
        // The newest release imported (by fiscal year and quarter), and when anything was last imported.
        sources.findOne({ type: program, status: 'done' }, { projection: { _id: 0, filename: 1, fiscalYear: 1, quarter: 1, completedAt: 1, progress: 1 }, sort: { fiscalYear: -1, quarter: -1 }, maxTimeMS: 2000 }),
        sources.find({ type: program }, { projection: { _id: 0, checkedAt: 1, completedAt: 1 }, maxTimeMS: 2000 }).toArray()
            .then(rows => ({ checkedAt: latestOf(rows, 'checkedAt'), importedAt: latestOf(rows.filter(row => row.completedAt), 'completedAt') })),
        db.collection('map_meta').findOne({ _id: program }, { projection: { _id: 0, years: 1 }, maxTimeMS: 2000 }),
    ]);
    return { program, label: LABELS[program], records: count, newestCase: newest,
        latestRelease: latest && { filename: latest.filename, fiscalYear: latest.fiscalYear, quarter: latest.quarter, importedAt: latest.completedAt,
            cases: latest.progress ? (latest.progress.inserted || 0) + (latest.progress.updated || 0) : null },
        lastCheckedAt: checked.checkedAt, lastImportedAt: checked.importedAt,
        years: (map?.years || []).map(({ year, total }) => ({ year, total })).sort((a, b) => a.year - b.year) };
}

async function collectionSizes(db) {
    const names = (await db.listCollections({ type: 'collection' }, { nameOnly: true }).toArray()).map(row => row.name).filter(name => !name.startsWith('system.'));
    const rows = await Promise.all(names.map(name => quietly(db.collection(name).aggregate([{ $collStats: { storageStats: { scale: 1 } } }], { maxTimeMS: 3000 }).next()
        .then(stats => ({ name, records: stats.storageStats.count, dataSize: stats.storageStats.size, storageSize: stats.storageStats.storageSize,
            indexSize: stats.storageStats.totalIndexSize })))));
    return rows.filter(Boolean).sort((a, b) => (b.storageSize + b.indexSize) - (a.storageSize + a.indexSize));
}

async function databaseHealth(db) {
    const [stats, server] = await Promise.all([
        db.stats(),
        quietly(db.admin().command({ serverStatus: 1, repl: 0, metrics: 0, locks: 0 })),
    ]);
    const cacheStats = server?.wiredTiger?.cache;
    return { name: db.databaseName, collections: stats.collections, records: stats.objects, dataSize: stats.dataSize, storageSize: stats.storageSize,
        indexSize: stats.indexSize, version: server?.version || null, uptimeSeconds: server?.uptime ?? null,
        connections: server?.connections ? { current: server.connections.current, available: server.connections.available } : null,
        cache: cacheStats ? { used: cacheStats['bytes currently in the cache'], max: cacheStats['maximum bytes configured'], dirty: cacheStats['tracked dirty bytes in the cache'] } : null,
        operations: server?.opcounters ? Object.fromEntries(['query', 'insert', 'update', 'delete', 'getmore', 'command'].map(key => [key, Number(server.opcounters[key] || 0)])) : null };
}

// The container's own memory use and limit (cgroup v2, then v1), when readable.
async function containerMemory() {
    const read = file => fs.readFile(file, 'utf8').then(text => text.trim()).catch(() => null);
    const [current, max] = await Promise.all([read('/sys/fs/cgroup/memory.current'), read('/sys/fs/cgroup/memory.max')]);
    if (current) return { used: Number(current), limit: max && max !== 'max' ? Number(max) : null };
    const [usage, limit] = await Promise.all([read('/sys/fs/cgroup/memory/memory.usage_in_bytes'), read('/sys/fs/cgroup/memory/memory.limit_in_bytes')]);
    return usage ? { used: Number(usage), limit: limit && Number(limit) < 2 ** 60 ? Number(limit) : null } : null;
}

async function serverHealth() {
    const memory = process.memoryUsage();
    return { host: os.hostname(), node: process.version, uptimeSeconds: Math.round(process.uptime()), startedAt: new Date(Date.now() - process.uptime() * 1000),
        version: process.env.APP_VERSION || null, cpus: os.cpus().length, load: os.loadavg().map(value => Math.round(value * 100) / 100),
        memory: { rss: memory.rss, heapUsed: memory.heapUsed, heapTotal: memory.heapTotal }, container: await containerMemory() };
}

function summarizeRun(run) {
    if (!run) return null;
    const outcomes = {};
    for (const result of run.results || []) outcomes[result.outcome || 'other'] = (outcomes[result.outcome || 'other'] || 0) + 1;
    return { id: run._id, mode: run.mode || null, status: run.status, startedAt: run.startedAt, finishedAt: run.finishedAt || run.completedAt || null,
        error: run.error || null, files: (run.results || []).length, outcomes };
}

async function jobs(db) {
    const state = db.collection('discovery_state');
    const [refresh, runs, backup, uscis] = await Promise.all([
        state.findOne({ _id: 'refresh' }, { projection: { history: 0 }, maxTimeMS: 2000 }),
        db.collection('import_runs').find({}, { sort: { startedAt: -1 }, limit: 12, maxTimeMS: 2000 }).toArray(),
        state.findOne({ _id: 'backup' }, { projection: { _id: 0 }, maxTimeMS: 2000 }),
        state.findOne({ _id: 'uscis_h1b' }, { projection: { _id: 0, job: 1 }, maxTimeMS: 2000 }),
    ]);
    const finished = runs.filter(run => run.status !== 'busy');
    return {
        refresh: refresh && { running: Boolean(refresh.running), outcome: refresh.outcome || null, startedAt: refresh.startedAt || null, finishedAt: refresh.finishedAt || null,
            step: refresh.step || null, args: refresh.args || [], error: refresh.error || null },
        imports: { latest: summarizeRun(finished[0]), recent: finished.slice(0, 8).map(summarizeRun) },
        backup: backup || null,
        uscis: uscis?.job || null,
    };
}

// One time-ordered list of what happened: admin events, import runs and refreshes.
async function activity(db) {
    const [events, runs, refresh] = await Promise.all([
        quietly(recentAdminEvents(db, { limit: 30 }), []),
        db.collection('import_runs').find({ status: { $ne: 'busy' } }, { projection: { results: 1, status: 1, mode: 1, startedAt: 1, finishedAt: 1, error: 1 }, sort: { startedAt: -1 }, limit: 10, maxTimeMS: 2000 }).toArray(),
        db.collection('discovery_state').findOne({ _id: 'refresh' }, { projection: { history: { $slice: -10 } }, maxTimeMS: 2000 }),
    ]);
    const items = [
        ...events.map(event => ({ kind: 'admin', ...event })),
        ...runs.map(run => ({ kind: 'import', at: run.startedAt, ...summarizeRun(run) })),
        ...(refresh?.history || []).map(run => ({ kind: 'refresh', at: run.startedAt, finishedAt: run.finishedAt, outcome: run.outcome, steps: run.steps || [], error: run.error || null })),
    ];
    return items.filter(item => item.at).sort((a, b) => new Date(b.at) - new Date(a.at)).slice(0, 40);
}

async function security(db, { blocked = [] } = {}) {
    const since = new Date(Date.now() - 86400000);
    const events = db.collection('admin_events');
    const [admins, failures, lastSignIn] = await Promise.all([
        db.collection('admins').find({}, { projection: { username: 1, createdAt: 1, updatedAt: 1, tokenVersion: 1, 'twoFactor.enabledAt': 1 }, sort: { createdAt: 1 }, maxTimeMS: 2000 }).toArray(),
        quietly(events.countDocuments({ type: 'sign-in-failed', at: { $gte: since } }, { maxTimeMS: 2000 }), 0),
        quietly(events.findOne({ type: 'sign-in' }, { projection: { _id: 0 }, sort: { at: -1 }, maxTimeMS: 2000 })),
    ]);
    return { admins: admins.map(admin => ({ username: admin.username, createdAt: admin.createdAt || null, updatedAt: admin.updatedAt || null, sessionVersion: admin.tokenVersion || 0, twoFactor: Boolean(admin.twoFactor?.enabledAt) })),
        failedSignIns24h: failures, lastSignIn, blockedAddresses: blocked.length };
}

async function getAdminOverview(db, { blocked } = {}) {
    const [datasets, uscisRecords, i140, database, collections, server, jobState, events, access] = await Promise.all([
        Promise.all(PROGRAMS.map(program => dataset(db, program))),
        quietly(db.collection('uscis_h1b').estimatedDocumentCount(), null),
        quietly(db.collection('uscis_i140').findOne({ _id: 'latest' }, { projection: { importedAt: 1, 'latest.fiscalYear': 1, 'latest.quarter': 1 }, maxTimeMS: 2000 })),
        databaseHealth(db),
        quietly(collectionSizes(db), []),
        serverHealth(),
        jobs(db),
        quietly(activity(db), []),
        security(db, { blocked }),
    ]);
    return { generatedAt: new Date(), datasets, uscis: { records: uscisRecords }, i140: i140 ? { importedAt: i140.importedAt || null, fiscalYear: i140.latest?.fiscalYear ?? null, quarter: i140.latest?.quarter ?? null } : null,
        database, collections, server, jobs: jobState, activity: events, security: access };
}

module.exports = { getAdminOverview, containerMemory, summarizeRun };
