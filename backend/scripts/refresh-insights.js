require('dotenv').config();
const mongoose = require('mongoose');
const { refreshGlobalInsights } = require('../services/searchInsights');

async function main() {
    if (!process.env.MONGO_URI) throw new Error('MONGO_URI is required');
    const args = process.argv.slice(2);
    if (args.some(value => value !== '--force')) throw new Error('Usage: node scripts/refresh-insights.js [--force]');
    const controller = new AbortController();
    const stop = () => controller.abort(new Error('Insights refresh interrupted'));
    process.once('SIGTERM', stop);
    process.once('SIGINT', stop);
    try {
        await mongoose.connect(process.env.MONGO_URI, { autoIndex: false, maxPoolSize: 2 });
        for (const [program, Model] of [['pwd', require('../models/Case')], ['perm', require('../models/PermCase')]]) {
            console.log(JSON.stringify(await refreshGlobalInsights(Model, program, { force: args.includes('--force'), signal: controller.signal })));
        }
    } finally {
        await mongoose.disconnect();
        process.removeListener('SIGTERM', stop);
        process.removeListener('SIGINT', stop);
    }
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
