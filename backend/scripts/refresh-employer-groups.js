require('dotenv').config();
const mongoose = require('mongoose');
const { groups, groupForId } = require('../services/employerGroups');
const { computeProfile } = require('../services/employers');

async function main() {
    if (!process.env.MONGO_URI) throw new Error('MONGO_URI is required');
    const args = process.argv.slice(2);
    if (args.length > 1 || args.some(arg => !arg.startsWith('--group='))) throw new Error('Usage: refresh-employer-groups.js [--group=<reviewed ID>]');
    const selected = args.length ? [groupForId(args[0].slice(8))] : groups;
    if (selected.some(group => !group)) throw new Error('Unknown reviewed employer group');
    const controller = new AbortController();
    const stop = () => controller.abort(new Error('Employer group refresh interrupted'));
    process.once('SIGTERM', stop); process.once('SIGINT', stop);
    try {
        await mongoose.connect(process.env.MONGO_URI, { autoIndex: false, maxPoolSize: 2 });
        const db = mongoose.connection.db, models = require('../models/programModels');
        for (const group of selected) {
            controller.signal.throwIfAborted();
            const employer = await db.collection('employers').findOne({ _id: group.id });
            if (!employer) throw new Error(`Employer directory is missing ${group.name}`);
            const snapshot = await computeProfile(db, models, employer, { maxTimeMS: 120000, signal: controller.signal });
            console.log(JSON.stringify({ group: group.name, cache: snapshot._id, updatedAt: snapshot.updatedAt,
                counts: Object.fromEntries(Object.entries(snapshot.summaries).map(([program, value]) => [program, value.totalCount])) }));
        }
    } finally {
        await mongoose.disconnect();
        process.removeListener('SIGTERM', stop); process.removeListener('SIGINT', stop);
    }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
