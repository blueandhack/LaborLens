// Scoped, idempotent repair of the FY2026 Q3 source error verified against DOL.
require('dotenv').config();
const mongoose = require('mongoose');
const { acquireImportLock } = require('../services/importLock');
const { resolveSourceCells } = require('../services/sourceCellResolutions');
const CASE_NUMBER = 'I-200-26154-978573';
const SHA256 = 'f8ca8448a528671f784d3692923775a13741c99caec2816b2fe30c8885bd28b3';
async function main() {
    await mongoose.connect(process.env.MONGO_URI, { autoIndex: false, maxPoolSize: 2 });
    let lease;
    try {
        const db = mongoose.connection.db;
        lease = await acquireImportLock(db, 'Resolve H-1B optional province source error');
        const record = await db.collection('h1bcases').findOne({ CASE_NUMBER });
        const source = await db.collection('import_sources').findOne({ type: 'h1b', sha256: SHA256 });
        if (!record || !source || record._DOL_SOURCE?.sha256 !== SHA256
            || record._DOL_CELL_ERRORS?.EMPLOYER_PROVINCE !== '#NAME?'
            || record.EMPLOYER_COUNTRY !== 'UNITED STATES OF AMERICA' || record.EMPLOYER_STATE !== 'MI'
            || source.validation?.issues?.['EMPLOYER_PROVINCE:excel_error'] !== 1) throw new Error('Source evidence differs from the reviewed repair; no repair applied');
        const resolutions = resolveSourceCells(record, 'h1b');
        if (!resolutions.EMPLOYER_PROVINCE) throw new Error('Record does not qualify for a province resolution');
        if (!process.argv.includes('--apply')) { console.log(JSON.stringify({ mode: 'preview', caseNumber: CASE_NUMBER, resolutions })); return; }
        lease.ensureActive();
        const result = await db.collection('h1bcases').updateOne({ _id: record._id, '_DOL_SOURCE.sha256': SHA256, '_DOL_CELL_ERRORS.EMPLOYER_PROVINCE': '#NAME?', EMPLOYER_PROVINCE: null }, {
            $set: { _DOL_CELL_RESOLUTIONS: record._DOL_CELL_RESOLUTIONS },
        });
        if (result.matchedCount !== 1) throw new Error('Record changed during repair');
        const examples = source.validation.examples.map(example => example.field === 'EMPLOYER_PROVINCE' && example.reason === 'excel_error' && example.value === '#NAME?'
            ? { ...example, resolution: resolutions.EMPLOYER_PROVINCE } : example);
        lease.ensureActive();
        await db.collection('import_sources').updateOne({ _id: source._id, sha256: SHA256 }, { $set: {
            'validation.resolvedIssues.EMPLOYER_PROVINCE:excel_error': 1, 'validation.examples': examples,
            'validation.resolutionNote': 'Optional province is not applicable to the reported US employer address. Original Excel error retained.',
        } });
        console.log(JSON.stringify({ repaired: CASE_NUMBER, normalizedValue: null, originalErrorRetained: true, resolvedSourceIssues: 1 }));
    } finally { if (lease) await lease.release(); await mongoose.disconnect(); }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
