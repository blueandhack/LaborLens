require('dotenv').config();
const mongoose = require('mongoose');
const { searchIndexes, programs } = require('../services/searchConfig');
const { normalizeWorksites } = require('../services/worksites');
const { randomUUID } = require('node:crypto');
const { refreshDirectory, refreshFeatured } = require('../services/employers');
const { refreshIdentities } = require('../services/employerIdentity');
const log = value => console.log(JSON.stringify({ time: new Date().toISOString(), ...value }));
async function main() {
    const args = process.argv.slice(2);
    if (args.some(arg => !['--worksites', '--directory', '--identities', '--profiles'].includes(arg))) throw new Error('Usage: refresh-employers.js [--worksites] [--directory] [--identities] [--profiles]');
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
        if (args.includes('--worksites')) for (const program of ['h1b', 'pwd', 'perm']) {
            const Model = models[program];
            for (const index of searchIndexes(program).filter(index => index.name.startsWith('discovery_'))) await Model.collection.createIndex(index.key, { name: index.name });
            const processed = await normalizeWorksites(Model, program, { signal: controller.signal, onProgress: log });
            for (const index of searchIndexes(program).filter(index => index.name.startsWith('search_worksite_'))) {
                log({ event: 'index', program, index: index.name });
                await Model.collection.createIndex(index.key, { name: index.name, partialFilterExpression: index.partialFilterExpression });
            }
            await db.collection('discovery_state').updateOne({ _id: 'worksites' }, { $set: { [`programs.${program}`]: { ready: true, updatedAt: new Date() } } }, { upsert: true });
            log({ event: 'worksites-ready', program, processed });
        }
        if (!args.length || args.includes('--directory')) await refreshDirectory(db, models, { signal: controller.signal, onProgress: log });
        // Identities follow the directory: they combine its reported names (and their counts).
        if (!args.length || args.includes('--directory') || args.includes('--identities')) await refreshIdentities(db, models, { signal: controller.signal, onProgress: log });
        if (!args.length || args.includes('--profiles')) await refreshFeatured(db, models, { signal: controller.signal, onProgress: log });
    } finally {
        clearInterval(heartbeat);
        await db.collection('discovery_locks').deleteOne({ _id: 'refresh', owner }).catch(() => {});
        await mongoose.disconnect();
    }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
