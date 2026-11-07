// Refresh source metadata only. Does not import or change any case records.
require('dotenv').config();
const mongoose = require('mongoose');
const { fetchDatasetInventory } = require('../services/dolSource');
async function main() {
    const { datasets, releases } = await fetchDatasetInventory({ fromYear: 2008, programs: ['pwd', 'perm', 'h1b'] });
    const unavailable = [];
    for (const type of ['pwd', 'perm', 'h1b']) {
        const years = new Set(datasets.filter(file => file.type === type).map(file => file.fiscalYear));
        for (let year = 2008; year <= Math.max(...years); year++) if (!years.has(year)) unavailable.push({ type, fiscalYear: year });
    }
    await mongoose.connect(process.env.MONGO_URI, { autoIndex: false, maxPoolSize: 2 });
    try {
        await mongoose.connection.db.collection('import_catalog').updateOne({ _id: 'dol' }, {
            $set: { datasets, releases, unavailable, fromYear: 2008, releasesCheckedAt: new Date() },
        }, { upsert: true });
        console.log(JSON.stringify({ selectedFiles: datasets.length, listedReleases: releases.length }));
    } finally { await mongoose.disconnect(); }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
