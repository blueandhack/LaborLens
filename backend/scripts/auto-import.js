require('dotenv').config();
const mongoose = require('mongoose');
const { fetchDatasets } = require('../services/dolSource');
const { runAutoImport } = require('../services/autoImport');
const { refreshGlobalInsights } = require('../services/searchInsights');

async function main() {
    const args = process.argv.slice(2);
    if (args.some(arg => !['--discover', '--force', '--backfill'].includes(arg) && !/^--(?:from-year|max-files)=\d+$/.test(arg) && !/^--programs=[a-z0-9,]+$/.test(arg))) {
        throw new Error('Usage: node scripts/auto-import.js [--discover] [--force] [--from-year=2008] [--max-files=2] [--backfill] [--programs=pwd,perm,h1b]');
    }
    const fromYear = args.find(arg => arg.startsWith('--from-year='))?.split('=')[1];
    const maxFiles = args.find(arg => arg.startsWith('--max-files='))?.split('=')[1];
    if (fromYear !== undefined && (Number(fromYear) < 2008 || Number(fromYear) > new Date().getUTCFullYear() + 1)) throw new Error('from-year is outside the DOL archive range');
    if (maxFiles !== undefined && Number(maxFiles) < 1) throw new Error('max-files must be positive');
    const models = require('../models/programModels');
    const programs = (args.find(arg => arg.startsWith('--programs='))?.split('=')[1] || 'pwd,perm,h1b').split(',');
    if (programs.some(type => !Object.hasOwn(models, type)) || new Set(programs).size !== programs.length) throw new Error('Invalid programs');
    const controller = new AbortController();
    const stop = () => controller.abort(new Error('Import interrupted; it will be retried on the next run'));
    process.once('SIGTERM', stop);
    process.once('SIGINT', stop);
    try {
        if (args.includes('--discover')) {
            console.log(JSON.stringify(await fetchDatasets({ programs, fromYear: fromYear === undefined ? undefined : Number(fromYear), signal: AbortSignal.any([controller.signal, AbortSignal.timeout(60000)]) }), null, 2));
            return;
        }
        if (!process.env.MONGO_URI) throw new Error('MONGO_URI is required');
        await mongoose.connect(process.env.MONGO_URI, { autoIndex: false, maxPoolSize: 3, maxIdleTimeMS: 60000, serverSelectionTimeoutMS: 30000 });
        const result = await runAutoImport(mongoose.connection.db, {
            models, programs,
            force: args.includes('--force'), signal: controller.signal,
            fromYear: fromYear === undefined ? undefined : Number(fromYear),
            maxFiles: maxFiles === undefined ? Infinity : Number(maxFiles), backfill: args.includes('--backfill'),
        });
        for (const program of [...new Set(result.results.filter(row => row.outcome === 'imported').map(row => row.type))]) {
            try { console.log(JSON.stringify(await refreshGlobalInsights(models[program], program, { signal: controller.signal }))); }
            catch (error) { console.warn(JSON.stringify({ event: 'insights-refresh-failed', error: error.message })); }
        }
    } finally {
        await mongoose.disconnect();
        process.removeListener('SIGTERM', stop);
        process.removeListener('SIGINT', stop);
    }
}

main().catch(error => {
    console.error(JSON.stringify({ event: 'failed', error: error.message }));
    process.exitCode = 1;
});
