// Imports USCIS H-1B Employer Data Hub files.
//
//   node scripts/import-uscis-h1b.js --official [dir]      # the archived FY2009–2023 files on uscis.gov (or already downloaded to dir)
//   node scripts/import-uscis-h1b.js --hub 2024 2025 [...]  # fiscal years from the H-1B Employer Data Hub (its public crosstab CSV)
//   node scripts/import-uscis-h1b.js --hub-recent           # the current and previous fiscal years, skipping unchanged downloads (monthly job)
//   node scripts/import-uscis-h1b.js file.csv [...]         # hub exports (CSV, or the crosstab's tab-separated UTF-16)
//   node scripts/import-uscis-h1b.js --relink              # re-link petitioner names to employers only
//   node scripts/import-uscis-h1b.js --recompute           # recalculate initial/continuing totals from stored petition types
//   Options: --allow-smaller (replace a year with a smaller file)
require('dotenv').config();
const { readFile } = require('node:fs/promises');
const { createHash } = require('node:crypto');
const path = require('node:path');
const mongoose = require('mongoose');
const { Readable, Transform } = require('node:stream');
const { STATE_ID, OFFICIAL_URL, OFFICIAL_YEARS, HUB_CSV_URL, parseUscisFile, parseUscisStream, importUscisRows, rebuildUscisEmployers, linkUscisEmployers, recomputeUscisTotals } = require('../services/uscisH1b');

const log = value => console.log(JSON.stringify({ time: new Date().toISOString(), ...value }));

async function download(url) {
    const response = await fetch(url, { headers: { 'User-Agent': 'LaborLens data import (+https://laborlens.fyi)' }, signal: AbortSignal.timeout(120000) });
    if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
    return Buffer.from(await response.arrayBuffer());
}

// USCIS fiscal year N runs October N-1 through September N.
const currentFiscalYear = (date = new Date()) => date.getUTCFullYear() + (date.getUTCMonth() >= 9 ? 1 : 0);

// Streams one fiscal year from the hub (about 100 MB). Returns its rows and the
// download's SHA-256, or null when the hub has nothing for that year yet.
async function fetchHubYear(year, { allowUnpublished = false } = {}) {
    const url = HUB_CSV_URL(year);
    const response = await fetch(url, { headers: { 'User-Agent': 'LaborLens data import (+https://laborlens.fyi)' }, signal: AbortSignal.timeout(15 * 60 * 1000) });
    if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
    const hash = createHash('sha256');
    const hashing = new Transform({ transform(chunk, _encoding, done) { hash.update(chunk); done(null, chunk); } });
    let parsed;
    try {
        parsed = await parseUscisStream(Readable.fromWeb(response.body).pipe(hashing));
    } catch (error) {
        if (allowUnpublished && /no data rows|empty/.test(error.message)) return null;
        throw error;
    }
    // A year the hub has not published can come back unfiltered (another year's rows).
    const other = parsed.rows.find(row => row.fiscalYear !== year);
    if (other) {
        if (allowUnpublished) return null;
        throw new Error(`The hub returned FY${other.fiscalYear} rows for FY${year}; its fiscal year filter may have changed.`);
    }
    return { ...parsed, sha256: hash.digest('hex') };
}

async function main() {
    const args = process.argv.slice(2);
    const recent = args.includes('--hub-recent');
    const hub = recent ? [currentFiscalYear() - 1, currentFiscalYear()]
        : args.includes('--hub') ? args.slice(args.indexOf('--hub') + 1).filter(arg => /^\d{4}$/.test(arg)).map(Number) : [];
    const files = args.filter((arg, index) => !arg.startsWith('--') && args[index - 1] !== '--official' && !(args.includes('--hub') && /^\d{4}$/.test(arg)));
    const official = args.includes('--official');
    const officialDir = official && args[args.indexOf('--official') + 1] && !args[args.indexOf('--official') + 1].startsWith('--') ? args[args.indexOf('--official') + 1] : null;
    if (!process.env.MONGO_URI) throw new Error('MONGO_URI is required');
    if (!official && !hub.length && !files.length && !args.includes('--relink') && !args.includes('--recompute')) throw new Error('Usage: import-uscis-h1b.js --official | --hub <year ...> | --hub-recent | --relink | --recompute | <file.csv ...> [--allow-smaller]');
    await mongoose.connect(process.env.MONGO_URI, { autoIndex: false, maxPoolSize: 3 });
    const db = mongoose.connection.db;
    try {
        if (args.includes('--relink')) { log({ event: 'linked', linked: await linkUscisEmployers(db) }); return; }
        if (args.includes('--recompute')) { const meta = await recomputeUscisTotals(db, { onProgress: log }); log({ event: 'done', employers: meta.employers, linked: meta.linked }); return; }
        const inputs = official ? OFFICIAL_YEARS.map(year => ({ url: OFFICIAL_URL(year), name: path.basename(OFFICIAL_URL(year)), file: officialDir && path.join(officialDir, path.basename(OFFICIAL_URL(year))) })) : files.map(file => ({ file, name: path.basename(file) }));
        let total = 0; const years = new Set();
        // One file at a time keeps memory small; the employer summary is rebuilt once at the end.
        for (const input of inputs) {
            const buffer = input.file ? await readFile(input.file) : await download(input.url);
            const parsed = parseUscisFile(buffer);
            const source = { name: input.name, url: input.url || null, official, archived: official, sha256: createHash('sha256').update(buffer).digest('hex'), format: parsed.format };
            log({ event: 'parsed', file: input.name, rows: parsed.rows.length, format: parsed.format });
            await importUscisRows(db, parsed.rows, { source, allowSmaller: args.includes('--allow-smaller'), rebuild: false, onProgress: log });
            total += parsed.rows.length; for (const row of parsed.rows) years.add(row.fiscalYear);
        }
        // Hub years. In the monthly job, a year whose download is unchanged is skipped,
        // and the newest year may not be published yet (early in a fiscal year).
        const imported = (await db.collection('discovery_state').findOne({ _id: STATE_ID }, { projection: { years: 1 } }))?.years || {};
        for (const year of hub) {
            const parsed = await fetchHubYear(year, { allowUnpublished: recent && year === hub.at(-1) });
            if (!parsed) { log({ event: 'hub-unpublished', fiscalYear: year }); continue; }
            if (recent && imported[year]?.source?.sha256 === parsed.sha256) { log({ event: 'hub-unchanged', fiscalYear: year }); continue; }
            log({ event: 'parsed', file: `hub FY${year}`, rows: parsed.rows.length, format: parsed.format });
            await importUscisRows(db, parsed.rows, { source: { name: `H-1B Employer Data Hub, FY${year}`, url: 'https://www.uscis.gov/tools/reports-and-studies/h-1b-employer-data-hub',
                official: true, hub: true, sha256: parsed.sha256, format: parsed.format }, allowSmaller: args.includes('--allow-smaller'), rebuild: false, onProgress: log });
            total += parsed.rows.length; years.add(year);
        }
        if (!years.size) { log({ event: 'done', rows: 0, years: [], message: 'Nothing changed.' }); return; }
        const meta = await rebuildUscisEmployers(db, { onProgress: log });
        log({ event: 'done', rows: total, years: [...years].sort(), employers: meta.employers, linked: meta.linked });
    } finally { await mongoose.disconnect(); }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
