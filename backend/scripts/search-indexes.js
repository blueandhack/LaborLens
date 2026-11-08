require('dotenv').config();
const mongoose = require('mongoose');
const { programs, searchIndexes } = require('../services/searchConfig');

async function main() {
    const args = process.argv.slice(2);
    if (args.some(arg => !['--prune-obsolete', '--check'].includes(arg))) throw new Error('Usage: node scripts/search-indexes.js [--check] [--prune-obsolete]');
    if (!process.env.MONGO_URI) throw new Error('MONGO_URI is required');
    await mongoose.connect(process.env.MONGO_URI, { autoIndex: false, maxPoolSize: 2 });
    try {
        for (const [program, config] of Object.entries(programs)) {
            const collection = mongoose.connection.db.collection(config.collection);
            const desired = searchIndexes(program);
            const before = await collection.indexes().catch(error => {
                // A newly added program has no collection until its first index.
                if (error.code === 26 && !args.includes('--check')) return [];
                throw error;
            });
            const unique = before.find(index => index.name === 'CASE_NUMBER_1');
            if (!unique || !unique.unique || JSON.stringify(unique.key) !== JSON.stringify({ CASE_NUMBER: 1 })) {
                if (args.includes('--check')) throw new Error(`Missing unique ${config.collection}.CASE_NUMBER_1`);
                await collection.createIndex({ CASE_NUMBER: 1 }, { unique: true, name: 'CASE_NUMBER_1' });
            }
            for (const index of desired) {
                if (args.includes('--check')) {
                    if (!before.some(existing => existing.name === index.name && JSON.stringify(existing.key) === JSON.stringify(index.key)
                        && JSON.stringify(existing.partialFilterExpression) === JSON.stringify(index.partialFilterExpression))) {
                        throw new Error(`Missing ${config.collection}.${index.name}`);
                    }
                } else {
                    console.log(`Ensuring ${config.collection}.${index.name}`);
                    await collection.createIndex(index.key, { name: index.name, ...(index.partialFilterExpression ? { partialFilterExpression: index.partialFilterExpression } : {}) });
                }
            }
            if (args.includes('--prune-obsolete')) {
                const names = new Set(['_id_', 'CASE_NUMBER_1', ...desired.map(index => index.name)]);
                // Restrict cleanup to the old search indexes owned by this app.
                const oldFields = new Set([config.company, config.employer, config.city, config.state,
                    program === 'pwd' ? 'EMPLOYER_CITY' : 'EMP_CITY', 'JOB_TITLE', 'JOB_TITLE_LOWER',
                    config.date, 'RECEIVED_DATE', 'JOB_OPP_PWD_NUMBER', '_fts', '_ftsx']);
                const textFields = program === 'pwd'
                    ? ['EMPLOYER_LEGAL_BUSINESS_NAME', 'CASE_NUMBER', 'EMPLOYER_ADDRESS_1', 'EMPLOYER_CITY', 'EMPLOYER_STATE', 'JOB_TITLE']
                    : ['EMP_BUSINESS_NAME', 'CASE_NUMBER', 'EMP_ADDR1', 'EMP_CITY', 'EMP_STATE', 'JOB_TITLE'];
                const obsolete = new Set([
                    ...[config.employer, config.city, config.state, program === 'pwd' ? 'EMPLOYER_CITY' : 'EMP_CITY', 'JOB_TITLE'].map(field => field + '_1'),
                    config.date + '_-1', 'RECEIVED_DATE_-1', `${config.date}_-1_${config.employer}_1`,
                    textFields.map(field => field + '_text').join('_'),
                    ...(program === 'pwd' ? ['EMPLOYER_NAME_LOWER_1_DET_DATE_-1', 'JOB_TITLE_LOWER_1_DET_DATE_-1', 'EMPLOYER_NAME_1_DET_DATE_-1', 'JOB_TITLE_1_DET_DATE_-1']
                        : ['EMP_NAME_LOWER_1_DEC_DATE_-1', 'JOB_TITLE_LOWER_1_DEC_DATE_-1', 'JOB_OPP_PWD_NUMBER_1']),
                    ...['recent', 'company', 'title', 'city', 'state', 'received'].map(name => `search_${name}_v1`),
                    'search_recent_v2', 'search_received_v2', 'search_recent_v3', 'search_company_v2', 'search_title_v2', 'search_city_v2', 'search_state_v2',
                ]);
                for (const index of before) {
                    if (obsolete.has(index.name) && !names.has(index.name) && !index.unique && index.expireAfterSeconds === undefined &&
                            !index.partialFilterExpression && !index.sparse && !index.hidden &&
                            (Object.keys(index.key).every(field => oldFields.has(field)) || /^search_(?:recent|company|title|city|state|received)_v1$/.test(index.name) || ['search_recent_v2', 'search_received_v2', 'search_recent_v3', 'search_company_v2', 'search_title_v2', 'search_city_v2', 'search_state_v2'].includes(index.name))) {
                        console.log(`Removing obsolete ${config.collection}.${index.name}`);
                        await collection.dropIndex(index.name);
                    }
                }
            }
            const stats = await mongoose.connection.db.command({ collStats: config.collection, scale: 1024 * 1024 });
            console.log(JSON.stringify({ collection: config.collection, indexes: stats.nindexes, indexMiB: stats.totalIndexSize }));
        }
    } finally { await mongoose.disconnect(); }
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
