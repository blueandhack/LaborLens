// Replaces each uncompressed search index with its zstd-compressed version,
// one index at a time: build the new index, wait for servers to hint it
// (services/indexHints.js refreshes every 30s), then drop the previous version.
// Only one extra index exists at once, which bounds the disk needed.
//
//   node scripts/compress-indexes.js [--program perm|pwd|h1b] [--dry-run]
require('dotenv').config();
const mongoose = require('mongoose');
const { programs, searchIndexes, legacyIndexNames, indexOptions } = require('../services/searchConfig');

const GiB = 2 ** 30, MIN_FREE = 3 * GiB;
// Longer than the servers' 30s hint cache. Tests shorten it.
const SWITCH_WAIT_MS = Number(process.env.INDEX_SWITCH_WAIT_MS ?? 45000);
const log = value => console.log(JSON.stringify({ time: new Date().toISOString(), ...value }));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function main() {
    const args = process.argv.slice(2);
    const only = args.includes('--program') ? args[args.indexOf('--program') + 1] : null;
    if (only && !programs[only]) throw new Error('Unknown program ' + only);
    const dryRun = args.includes('--dry-run');
    if (!process.env.MONGO_URI) throw new Error('MONGO_URI is required');
    await mongoose.connect(process.env.MONGO_URI, { autoIndex: false, maxPoolSize: 2 });
    const db = mongoose.connection.db;
    const free = async () => { const stats = await db.command({ dbStats: 1 }); return stats.fsTotalSize - stats.fsUsedSize; };
    const sizes = async name => (await db.command({ collStats: name })).indexSizes || {};
    let freed = 0;
    try {
        for (const program of ['perm', 'pwd', 'h1b']) {
            if (only && program !== only) continue;
            const collection = db.collection(programs[program].collection);
            const before = Object.values(await sizes(collection.collectionName)).reduce((sum, size) => sum + size, 0);
            for (const index of searchIndexes(program)) {
                const legacy = legacyIndexNames[index.name];
                const names = new Set((await collection.listIndexes().toArray()).map(row => row.name));
                if (!names.has(index.name)) {
                    const legacySize = (await sizes(collection.collectionName))[legacy] || 0, available = await free();
                    if (available < MIN_FREE + legacySize) throw new Error(`Only ${(available / GiB).toFixed(1)} GiB free; need ${((MIN_FREE + legacySize) / GiB).toFixed(1)} GiB to build ${index.name} safely`);
                    log({ event: 'building', program, index: index.name, replaces: legacy || null, freeGiB: +(available / GiB).toFixed(2), dryRun });
                    if (dryRun) continue;
                    const started = Date.now();
                    await collection.createIndex(index.key, indexOptions(index));
                    log({ event: 'built', program, index: index.name, seconds: Math.round((Date.now() - started) / 1000),
                        sizeMiB: Math.round(((await sizes(collection.collectionName))[index.name] || 0) / 2 ** 20) });
                    if (legacy && names.has(legacy)) await sleep(SWITCH_WAIT_MS);
                }
                if (legacy && names.has(legacy) && !dryRun) {
                    const size = (await sizes(collection.collectionName))[legacy] || 0;
                    await collection.dropIndex(legacy);
                    freed += size;
                    log({ event: 'dropped', program, index: legacy, freedMiB: Math.round(size / 2 ** 20), freeGiB: +((await free()) / GiB).toFixed(2) });
                }
            }
            const after = Object.values(await sizes(collection.collectionName)).reduce((sum, size) => sum + size, 0);
            log({ event: 'program-done', program, indexGiBBefore: +(before / GiB).toFixed(2), indexGiBAfter: +(after / GiB).toFixed(2) });
        }
        log({ event: 'done', freedGiB: +(freed / GiB).toFixed(2), freeGiB: +((await free()) / GiB).toFixed(2) });
    } finally { await mongoose.disconnect(); }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
