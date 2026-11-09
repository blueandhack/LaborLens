// Imports USCIS Form I-140 statistics.
//
//   node scripts/import-i140.js                       # find the latest workbooks on uscis.gov and import them
//   node scripts/import-i140.js --quarterly a.xlsx [b.xlsx ...] --cohorts c.xlsx --awaiting d.xlsx
require('dotenv').config();
const { readFile } = require('node:fs/promises');
const path = require('node:path');
const mongoose = require('mongoose');
const { downloadLatest, importI140 } = require('../services/i140');

const log = value => console.log(JSON.stringify({ time: new Date().toISOString(), ...value }));

function fileArguments(args) {
    const files = { quarterly: [], cohorts: [], awaiting: [] };
    let kind = null;
    for (const arg of args) {
        if (arg.startsWith('--')) kind = arg.slice(2);
        else if (files[kind]) files[kind].push(arg);
        else throw new Error(`Unexpected argument ${arg}`);
    }
    return files;
}

async function main() {
    if (!process.env.MONGO_URI) throw new Error('MONGO_URI is required');
    const args = fileArguments(process.argv.slice(2));
    const local = args.quarterly.length || args.cohorts.length || args.awaiting.length;
    if (local && (!args.quarterly.length || args.cohorts.length !== 1 || args.awaiting.length !== 1)) throw new Error('Give --quarterly files, one --cohorts file and one --awaiting file');
    const read = async file => ({ name: path.basename(file), buffer: await readFile(file) });
    const files = local ? { quarterly: await Promise.all(args.quarterly.map(read)), cohorts: await read(args.cohorts[0]), awaiting: await read(args.awaiting[0]) }
        : await downloadLatest({ log });
    await mongoose.connect(process.env.MONGO_URI, { autoIndex: false, maxPoolSize: 2 });
    try {
        const snapshot = await importI140(mongoose.connection.db, files);
        log({ event: 'done', quarters: snapshot.quarters.map(quarter => `FY${quarter.fiscalYear} Q${quarter.quarter}`), filingYears: snapshot.cohorts.asOf, awaitingAsOf: snapshot.awaiting.asOf,
            sources: [...snapshot.sources, snapshot.cohorts.source, snapshot.awaiting.source].map(source => source.name) });
    } finally { await mongoose.disconnect(); }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
