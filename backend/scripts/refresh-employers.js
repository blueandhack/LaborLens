require('dotenv').config();
const mongoose = require('mongoose');
const { searchIndexes, programs } = require('../services/searchConfig');
const { ensureSearchIndex } = require('../services/indexHints');
const { normalizeWorksites } = require('../services/worksites');
const { randomUUID } = require('node:crypto');
const { refreshDirectory, refreshFeatured } = require('../services/employers');
const { refreshIdentities } = require('../services/employerIdentity');
const { refreshMap } = require('../services/map');
const { linkUscisEmployers, EMPLOYERS: USCIS_EMPLOYERS } = require('../services/uscisH1b');
const { createRunRecorder } = require('../services/siteStatus');
let run = null;
// Progress lines go to the job log and, throttled, to the administration page.
const log = value => { console.log(JSON.stringify({ time: new Date().toISOString(), ...value })); return run?.event(value); };
async function main() {
    const args = process.argv.slice(2);
    if (args.some(arg => !['--worksites', '--directory', '--identities', '--map', '--map-force', '--profiles'].includes(arg))) throw new Error('Usage: refresh-employers.js [--worksites] [--directory] [--identities] [--map | --map-force] [--profiles]');
    if (!process.env.MONGO_URI) throw new Error('MONGO_URI is required');
    const controller = new AbortController();
    const stop = () => controller.abort(new Error('Employer refresh interrupted'));
    process.once('SIGTERM', stop); process.once('SIGINT', stop);
    await mongoose.connect(process.env.MONGO_URI, { autoIndex: false, maxPoolSize: 3, serverSelectionTimeoutMS: 10000 });
    const db = mongoose.connection.db, models = require('../models/programModels');
    const owner = randomUUID(); let heartbeat;
    try {
        try {
            const lease = await db.collection('discovery_locks').findOneAndUpdate({ _id: 'refresh', expiresAt: { $lt: new Date() } },
                { $set: { owner, expiresAt: new Date(Date.now() + 5 * 60 * 1000) } }, { upsert: true, returnDocument: 'after' });
            if (lease.owner !== owner) throw new Error('Employer refresh already running');
        } catch (error) { if (error.code === 11000) { log({ event: 'busy', message: 'Employer refresh already running' }); return; } throw error; }
        heartbeat = setInterval(() => db.collection('discovery_locks').updateOne({ _id: 'refresh', owner }, { $set: { expiresAt: new Date(Date.now() + 5 * 60 * 1000) } })
            .then(result => { if (!result.matchedCount) controller.abort(new Error('Employer refresh lease lost')); })
            .catch(error => controller.abort(error)), 30000);
        heartbeat.unref();
        run = createRunRecorder(db, args);
        await run.start();
        if (args.includes('--worksites')) await run.step('Worksite search fields');
        for (const program of args.includes('--worksites') ? ['h1b', 'pwd', 'perm'] : []) {
            const Model = models[program];
            for (const index of searchIndexes(program).filter(index => index.name.startsWith('discovery_'))) await ensureSearchIndex(Model.collection, index);
            const processed = await normalizeWorksites(Model, program, { signal: controller.signal, onProgress: log });
            for (const index of searchIndexes(program).filter(index => index.name.startsWith('search_worksite_'))) {
                log({ event: 'index', program, index: index.name, result: await ensureSearchIndex(Model.collection, index) });
            }
            await db.collection('discovery_state').updateOne({ _id: 'worksites' }, { $set: { [`programs.${program}`]: { ready: true, updatedAt: new Date() } } }, { upsert: true });
            log({ event: 'worksites-ready', program, processed });
        }
        if (!args.length || args.includes('--directory')) { await run.step('Employer directory'); await refreshDirectory(db, models, { signal: controller.signal, onProgress: log }); }
        // Identities follow the directory: they combine its reported names (and their counts).
        if (!args.length || args.includes('--directory') || args.includes('--identities')) { await run.step('Employer identities'); await refreshIdentities(db, models, { signal: controller.signal, onProgress: log }); }
        // USCIS petitioner names link to employer names; new filing names can add links.
        if ((!args.length || args.includes('--directory') || args.includes('--identities')) && await db.collection(USCIS_EMPLOYERS).estimatedDocumentCount()) {
            await run.step('USCIS employer links'); await linkUscisEmployers(db, { signal: controller.signal });
        }
        // The map skips programs whose cases are unchanged since its last build.
        // Profiles follow it: their worksite maps use the map's learned city areas.
        if (!args.length || args.includes('--map') || args.includes('--map-force')) { await run.step('Worksite map'); await refreshMap(db, models, { signal: controller.signal, onProgress: log, force: args.includes('--map-force') }); }
        if (!args.length || args.includes('--profiles')) { await run.step('Featured employer profiles'); await refreshFeatured(db, models, { signal: controller.signal, onProgress: log }); }
        await run?.finish();
    } catch (error) {
        await run?.finish(error);
        throw error;
    } finally {
        clearInterval(heartbeat);
        await db.collection('discovery_locks').deleteOne({ _id: 'refresh', owner }).catch(() => {});
        await mongoose.disconnect();
    }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
