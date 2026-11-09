// Index hints that survive an index replacement. A new search index version
// (searchConfig legacyIndexNames) is hinted once it is fully built; until then
// its previous version is hinted. Lets a migration build each new index, then
// drop the old one, without failing searches in between.
const { legacyIndexNames, indexOptions } = require('./searchConfig');

const TTL_MS = 30000;
const cache = new Map();

// Names of a collection's fully built indexes: a Set once known (cached), or a
// promise of one. $indexStats marks in-progress builds (listIndexes lists them
// too, but a hint on one fails).
function readyIndexes(collection) {
    const key = `${collection.dbName}.${collection.collectionName}`;
    const entry = cache.get(key);
    if (entry && entry.expires > Date.now()) return entry.names;
    const entryNow = { expires: Date.now() + TTL_MS };
    entryNow.names = collection.aggregate([{ $indexStats: {} }, { $project: { name: 1, building: 1 } }], { maxTimeMS: 2000 }).toArray()
        .then(rows => (entryNow.names = new Set(rows.filter(row => !row.building).map(row => row.name))))
        .catch(error => { cache.delete(key); throw error; });
    cache.set(key, entryNow);
    return entryNow.names;
}

const choose = (ready, hint, legacy) => ready.has(hint) || !ready.has(legacy) ? hint : legacy;

// The index name to hint: synchronous when already known (no previous version,
// or a cached index list), so ordinary queries start without an extra tick.
function hintFor(collection, hint) {
    const legacy = typeof hint === 'string' ? legacyIndexNames[hint] : null;
    if (!legacy || typeof collection?.aggregate !== 'function' || !collection.collectionName) return hint;
    let ready;
    try { ready = readyIndexes(collection); } catch { return hint; }
    return ready instanceof Set ? choose(ready, hint, legacy) : ready.then(names => choose(names, hint, legacy), () => hint);
}

// Creates a search index unless it exists, or its previous version still does
// (scripts/compress-indexes.js replaces those one at a time to bound disk use).
async function ensureSearchIndex(collection, index) {
    const names = new Set((await collection.listIndexes().toArray().catch(error => { if (error.code === 26) return []; throw error; })).map(row => row.name));
    if (names.has(index.name)) return 'exists';
    if (names.has(legacyIndexNames[index.name])) return 'awaiting-replacement';
    await collection.createIndex(index.key, indexOptions(index));
    return 'created';
}

module.exports = { hintFor, ensureSearchIndex, clearIndexHints: () => cache.clear() };
