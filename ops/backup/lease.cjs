// Run in the backend container so backups use the same lease as imports/clears.
// stdin stays open until the coordinator has finished reading the database.
const { MongoClient } = require('mongodb');
const { acquireImportLock } = require('./services/importLock');
const { setTimeout: delay } = require('node:timers/promises');

let stopping = false;
process.stdin.resume();
process.stdin.on('end', () => { stopping = true; });
process.stdin.on('data', () => { stopping = true; });
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => { stopping = true; });
process.stdout.on('error', () => { stopping = true; });
const emit = value => process.stdout.write(JSON.stringify(value) + '\n');

(async () => {
    const client = await MongoClient.connect(process.env.MONGO_URI, {
        serverSelectionTimeoutMS: 10000, socketTimeoutMS: 30000,
    });
    let lease;
    let timer;
    try {
        const db = client.db();
        const deadline = Date.now() + Number(process.env.BACKUP_WAIT_MS || 21600000);
        let lastWaitingNotice = 0;
        while (!stopping && !lease) {
            try {
                lease = await acquireImportLock(db, 'Encrypted Google Drive backup', {
                    leaseMs: 180000, heartbeatMs: 15000,
                });
            } catch (error) {
                if (error.status !== 409 || Date.now() >= deadline) throw error;
                // Catch short gaps between delayed hourly imports without flooding logs.
                if (Date.now() - lastWaitingNotice >= 15000) {
                    emit({ event: 'waiting' });
                    lastWaitingNotice = Date.now();
                }
                await delay(1000);
            }
        }
        if (stopping) return;
        const collections = [];
        for (const { name } of await db.listCollections({}, { nameOnly: true }).toArray()) {
            if (name === 'import_locks') continue;
            const stats = await db.command({ collStats: name });
            collections.push({ name, count: stats.count, indexes: await db.collection(name).indexes() });
        }
        const build = await client.db('admin').command({ buildInfo: 1 });
        lease.ensureActive();
        emit({ event: 'ready', manifest: {
            database: db.databaseName, mongoVersion: build.version,
            capturedAt: new Date().toISOString(), collections,
            consistency: 'Case mutations excluded by the shared import/clear lease. Runtime import run records and independent admin password changes may occur during the dump.',
            excludedCollections: ['import_locks'],
        } });
        timer = setInterval(() => {
            try { lease.ensureActive(); emit({ event: 'heartbeat' }); }
            catch (error) { emit({ event: 'error', message: error.message }); stopping = true; }
        }, 5000);
        while (!stopping) await delay(250);
    } finally {
        clearInterval(timer);
        try { if (lease) await lease.release(); }
        finally { await client.close(); }
    }
})().catch(error => { console.error(error.message); process.exitCode = 1; });
