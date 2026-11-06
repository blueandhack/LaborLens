require('dotenv').config();
const mongoose = require('mongoose');
const { fetchDatasets } = require('../services/dolSource');
const { runAutoImport } = require('../services/autoImport');

async function main() {
    const args = process.argv.slice(2);
    if (args.some(arg => !['--discover', '--force', '--backfill'].includes(arg) && !/^--(?:from-year|max-files)=\d+$/.test(arg))) {
        throw new Error('Usage: node scripts/auto-import.js [--discover] [--force] [--from-year=2008] [--max-files=2] [--backfill]');
    }
    const fromYear = args.find(arg => arg.startsWith('--from-year='))?.split('=')[1];
    const maxFiles = args.find(arg => arg.startsWith('--max-files='))?.split('=')[1];
    if (fromYear !== undefined && (Number(fromYear) < 2008 || Number(fromYear) > new Date().getUTCFullYear() + 1)) throw new Error('from-year is outside the DOL archive range');
    if (maxFiles !== undefined && Number(maxFiles) < 1) throw new Error('max-files must be positive');
    const controller = new AbortController();
    const stop = () => controller.abort(new Error('Import interrupted; it will be retried on the next run'));
    process.once('SIGTERM', stop);
    process.once('SIGINT', stop);
    try {
        if (args.includes('--discover')) {
            console.log(JSON.stringify(await fetchDatasets({ fromYear: fromYear === undefined ? undefined : Number(fromYear), signal: AbortSignal.any([controller.signal, AbortSignal.timeout(60000)]) }), null, 2));
            return;
        }
        if (!process.env.MONGO_URI) throw new Error('MONGO_URI is required');
        await mongoose.connect(process.env.MONGO_URI, { autoIndex: false, serverSelectionTimeoutMS: 30000 });
        await runAutoImport(mongoose.connection.db, {
            models: { pwd: require('../models/Case'), perm: require('../models/PermCase') },
            force: args.includes('--force'), signal: controller.signal,
            fromYear: fromYear === undefined ? undefined : Number(fromYear),
            maxFiles: maxFiles === undefined ? Infinity : Number(maxFiles), backfill: args.includes('--backfill'),
        });
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
