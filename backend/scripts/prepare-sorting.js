require('dotenv').config();
const mongoose = require('mongoose');
const { searchIndexes } = require('../services/searchConfig');
const { ensureSearchIndex } = require('../services/indexHints');
const { ensureEmployerIndexes } = require('../services/employers');

async function main() {
    if (!process.env.MONGO_URI) throw new Error('MONGO_URI is required');
    await mongoose.connect(process.env.MONGO_URI, { autoIndex: false, maxPoolSize: 2 });
    try {
        await ensureEmployerIndexes(mongoose.connection.db);
        for (const index of searchIndexes('h1b').filter(index => index.name.startsWith('search_certification_'))) {
            console.log(JSON.stringify({ at: new Date().toISOString(), event: 'building', index: index.name }));
            await ensureSearchIndex(mongoose.connection.db.collection('h1bcases'), index);
            console.log(JSON.stringify({ at: new Date().toISOString(), event: 'ready', index: index.name }));
        }
    } finally { await mongoose.disconnect(); }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
