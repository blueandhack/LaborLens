// Rewrites each case collection with zstd block compression (data and every
// index), one collection at a time: copy it into a new zstd collection, build
// its indexes there, check the copy, then swap it in with an atomic rename.
// Holds the import lock and the refresh lease throughout, so no import, clear
// or worksite refresh can write cases that the copy would miss.
//
//   node scripts/compress-collections.js [--program perm|pwd|h1b] [--dry-run]
require('dotenv').config();
const mongoose = require('mongoose');
const { randomUUID } = require('node:crypto');
const { programs } = require('../services/searchConfig');
const { acquireImportLock } = require('../services/importLock');

const GiB = 2 ** 30, MIN_FREE = 3 * GiB, LEASE_MS = 5 * 60 * 1000;
const ZSTD = { wiredTiger: { configString: 'block_compressor=zstd' } };
const log = value => console.log(JSON.stringify({ time: new Date().toISOString(), ...value }));
const gib = bytes => +(bytes / GiB).toFixed(2);

// The nightly refresh's lease (scripts/refresh-employers.js): its worksite step writes cases.
async function acquireRefreshLease(db) {
    const locks = db.collection('discovery_locks'), owner = randomUUID();
    let lost = null;
    try {
        await locks.findOneAndUpdate({ _id: 'refresh', expiresAt: { $lt: new Date() } }, { $set: { owner, expiresAt: new Date(Date.now() + LEASE_MS) } }, { upsert: true });
    } catch (error) { if (error.code === 11000) throw new Error('The nightly refresh is running; try again when it finishes.'); throw error; }
    const timer = setInterval(() => locks.updateOne({ _id: 'refresh', owner }, { $set: { expiresAt: new Date(Date.now() + LEASE_MS) } })
        .then(result => { if (!result.matchedCount) lost = new Error('Refresh lease lost'); }, error => { lost = error; }), 30000);
    timer.unref();
    return {
        ensureActive() { if (lost) throw lost; },
        async release() { clearInterval(timer); await locks.deleteOne({ _id: 'refresh', owner }); },
    };
}

async function compressor(collection) {
    const [stats] = await collection.aggregate([{ $collStats: { storageStats: {} } }]).toArray();
    return stats.storageStats.wiredTiger?.creationString?.match(/block_compressor=(\w*)/)?.[1] ?? null;
}

async function main() {
    const args = process.argv.slice(2);
    const only = args.includes('--program') ? args[args.indexOf('--program') + 1] : null;
    if (only && !programs[only]) throw new Error('Unknown program ' + only);
    const dryRun = args.includes('--dry-run');
    if (!process.env.MONGO_URI) throw new Error('MONGO_URI is required');
    await mongoose.connect(process.env.MONGO_URI, { autoIndex: false, maxPoolSize: 3 });
    const db = mongoose.connection.db;
    const free = async () => { const stats = await db.command({ dbStats: 1 }); return stats.fsTotalSize - stats.fsUsedSize; };
    const startFree = await free();
    let importLock, refreshLease, progress;
    const ensureLocks = () => { importLock.ensureActive(); refreshLease.ensureActive(); };
    try {
        if (!dryRun) {
            importLock = await acquireImportLock(db, 'Compressing case data');
            refreshLease = await acquireRefreshLease(db);
        }
        for (const program of ['perm', 'pwd', 'h1b']) {
            if (only && program !== only) continue;
            const name = programs[program].collection, target = `${name}_zstd`, source = db.collection(name);
            if (!(await db.listCollections({ name }).toArray()).length) { log({ event: 'skipped', program, reason: 'missing' }); continue; }
            if (await compressor(source) === 'zstd') { log({ event: 'skipped', program, reason: 'already zstd' }); continue; }
            const stats = await db.command({ collStats: name });
            // The copy is at most the uncompressed collection's on-disk size; the old one is removed only at the swap.
            const needed = MIN_FREE + stats.storageSize + stats.totalIndexSize;
            const available = await free();
            log({ event: 'copying', program, cases: stats.count, storageGiB: gib(stats.storageSize), indexGiB: gib(stats.totalIndexSize), freeGiB: gib(available), dryRun });
            if (available < needed) throw new Error(`Only ${gib(available)} GiB free; need ${gib(needed)} GiB to copy ${name} safely`);
            if (dryRun) continue;

            await db.collection(target).drop().catch(error => { if (error.code !== 26) throw error; });
            try {
                await db.createCollection(target, { storageEngine: ZSTD, indexOptionDefaults: { storageEngine: ZSTD } });
                // $out into an existing collection keeps its options (zstd); the copy builds in tmp.agg_out.*.
                progress = setInterval(async () => {
                    const [temp] = await db.listCollections({ name: /^tmp\.agg_out/ }, { nameOnly: true }).toArray().catch(() => []);
                    if (temp) log({ event: 'copy-progress', program, copied: await db.collection(temp.name).estimatedDocumentCount().catch(() => null), of: stats.count });
                }, 60000);
                let started = Date.now();
                await source.aggregate([{ $out: target }], { hint: { $natural: 1 } }).toArray();
                clearInterval(progress);
                log({ event: 'copied', program, seconds: Math.round((Date.now() - started) / 1000), dataGiB: gib((await db.command({ collStats: target })).storageSize) });

                // One index at a time bounds the build's sort spill on disk.
                const indexes = (await source.listIndexes().toArray()).filter(index => index.name !== '_id_');
                for (const { v, ns, ...index } of indexes) {
                    ensureLocks();
                    const available = await free();
                    if (available < MIN_FREE + (stats.indexSizes[index.name] || 0)) throw new Error(`Only ${gib(available)} GiB free to build ${index.name}`);
                    started = Date.now();
                    await db.command({ createIndexes: target, indexes: [index] });
                    log({ event: 'index-built', program, index: index.name, seconds: Math.round((Date.now() - started) / 1000) });
                }

                ensureLocks();
                const [sourceCount, targetCount] = await Promise.all([source.countDocuments({}, { hint: '_id_' }), db.collection(target).countDocuments({}, { hint: '_id_' })]);
                const names = async collection => (await collection.listIndexes().toArray()).map(index => index.name).sort().join();
                if (sourceCount !== stats.count || targetCount !== sourceCount) throw new Error(`${name} changed during the copy (${stats.count} → ${sourceCount}, copied ${targetCount})`);
                if (await names(source) !== await names(db.collection(target))) throw new Error(`${target} indexes differ from ${name}`);
                await db.admin().command({ renameCollection: `${db.databaseName}.${target}`, to: `${db.databaseName}.${name}`, dropTarget: true });
            } catch (error) {
                clearInterval(progress);
                await db.collection(target).drop().catch(() => {});
                throw error;
            }
            const after = await db.command({ collStats: name });
            log({ event: 'swapped', program, storageGiBBefore: gib(stats.storageSize), storageGiBAfter: gib(after.storageSize),
                indexGiBBefore: gib(stats.totalIndexSize), indexGiBAfter: gib(after.totalIndexSize), freeGiB: gib(await free()) });
        }
        const end = await free();
        log({ event: 'done', freedGiB: gib(end - startFree), freeGiB: gib(end) });
    } finally {
        clearInterval(progress);
        await refreshLease?.release().catch(() => {});
        await importLock?.release().catch(() => {});
        await mongoose.disconnect();
    }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
