require('dotenv').config();
const mongoose = require('mongoose');
const { fetchDatasets } = require('../services/dolSource');
const { runAutoImport } = require('../services/autoImport');

async function main() {
    const args = process.argv.slice(2);
    if (args.some(arg => !['--discover', '--force'].includes(arg))) {
        throw new Error('Usage: node scripts/auto-import.js [--discover] [--force]');
    }
    const controller = new AbortController();
    const stop = () => controller.abort(new Error('Import interrupted; it will be retried on the next run'));
    process.once('SIGTERM', stop);
    process.once('SIGINT', stop);
    try {
        if (args.includes('--discover')) {
            console.log(JSON.stringify(await fetchDatasets({ signal: AbortSignal.any([controller.signal, AbortSignal.timeout(60000)]) }), null, 2));
            return;
        }
        if (!process.env.MONGO_URI) throw new Error('MONGO_URI is required');
        await mongoose.connect(process.env.MONGO_URI, { autoIndex: false, serverSelectionTimeoutMS: 30000 });
        await runAutoImport(mongoose.connection.db, {
            models: { pwd: require('../models/Case'), perm: require('../models/PermCase') },
            force: args.includes('--force'), signal: controller.signal,
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
