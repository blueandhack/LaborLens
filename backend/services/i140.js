// USCIS Form I-140 (immigrant petition for alien workers) statistics. USCIS
// publishes national counts only (no employer detail), in three quarterly
// workbooks on its Immigration and Citizenship Data page:
//   i140_fyYYYY_qN            received/approved/denied/pending by quarter and category,
//                             plus the latest quarter by beneficiary state and country of birth
//   i140_rec_by_class_country petitions by fiscal year filed and their current status
//   eb_i140_i360_i526_performancedata  approved petitions awaiting a visa, by country
const ExcelJS = require('exceljs');
const { parseCsv, decodeText } = require('./uscisH1b');

const DATA_PAGE = 'https://www.uscis.gov/tools/reports-and-studies/immigration-and-citizenship-data';
const FILE_BASE = 'https://www.uscis.gov/sites/default/files/document/data/';
const FIRST_QUARTERLY_YEAR = 2022; // Earlier years are published only as PDFs.
// Full-year files from before the current workbook names (CSV, one file per sheet).
const OLDER_QUARTERLY = { 2022: ['I140_FY22_Q4_RADP.csv'], 2023: ['i140_fy23_q4_radp.csv'] };
// Earlier reports by fiscal year filed, newest first: they add FY2013 and FY2012.
const COHORT_HISTORY = ['https://www.uscis.gov/sites/default/files/document/data/I140_rec_by_class_country_FY2022_Q3_Q4.csv',
    'https://www.uscis.gov/sites/default/files/document/reports/I140_rec_by_class_country_FY2021_Q3_Q4.csv'];
const DOC_ID = 'latest';
const COLLECTION = 'uscis_i140';

const CATEGORIES = [
    { code: 'all', label: 'All categories', level: 'all' },
    { code: 'eb1', label: 'EB-1 (first preference)', level: 'eb1' },
    { code: 'eb1a', label: 'EB-1A extraordinary ability', level: 'eb1' },
    { code: 'eb1b', label: 'EB-1B outstanding professor or researcher', level: 'eb1' },
    { code: 'eb1c', label: 'EB-1C multinational executive or manager', level: 'eb1' },
    { code: 'eb2', label: 'EB-2 (second preference)', level: 'eb2' },
    { code: 'eb2a', label: 'EB-2 advanced degree or exceptional ability', level: 'eb2' },
    { code: 'niw', label: 'EB-2 national interest waiver (NIW)', level: 'eb2' },
    { code: 'eb3', label: 'EB-3 (third preference)', level: 'eb3' },
    { code: 'eb3s', label: 'EB-3 skilled worker', level: 'eb3' },
    { code: 'eb3p', label: 'EB-3 professional (bachelor’s degree)', level: 'eb3' },
    { code: 'eb3u', label: 'EB-3 other (unskilled) worker', level: 'eb3' },
];
const CODES = { EB1: 'eb1', EB2: 'eb2', EB3: 'eb3', E11: 'eb1a', E12: 'eb1b', E13: 'eb1c', E21: 'eb2a', NIW: 'niw', E31: 'eb3s', E32: 'eb3p', EW3: 'eb3u' };
const PATTERNS = [['all', /^(grand )?total$/i], ['eb1', /first preference/i], ['eb2', /second preference/i], ['eb3', /third preference/i],
    ['niw', /national interest/i], ['eb1a', /extraordinary ability/i], ['eb1b', /outstanding professor/i], ['eb1c', /multi-?national/i],
    ['eb3u', /unskilled|other worker/i], ['eb3s', /skilled worker/i], ['eb3p', /baccalaureate/i], ['eb2a', /advanced deg|exceptional ability/i]];
function categoryOf(label) {
    const code = String(label).match(/\((EB[123]|E1[123]|E21|NIW|E3[12]|EW3)\)/i)?.[1]?.toUpperCase();
    if (code) return CODES[code];
    return PATTERNS.find(([, pattern]) => pattern.test(String(label).trim()))?.[0] || null;
}

const text = value => {
    if (value && typeof value === 'object') value = value.result ?? value.richText?.map(part => part.text).join('') ?? value.text ?? '';
    return String(value ?? '').replace(/\s+/g, ' ').trim();
};
const number = value => {
    if (value && typeof value === 'object') value = value.result ?? value.text;
    if (typeof value === 'number') return value;
    const cleaned = String(value ?? '').replace(/[,\s]/g, '');
    if (cleaned === '' || cleaned === '-' || /^n\/?a$/i.test(cleaned)) return 0;
    const parsed = Number(cleaned);
    if (!Number.isFinite(parsed)) throw new Error(`Unexpected value "${value}"`);
    return parsed;
};
const rowsOf = sheet => {
    const rows = [];
    sheet.eachRow({ includeEmpty: false }, row => rows.push(row.values.slice(1)));
    return rows;
};
const isEnd = label => /^(table key|notes?|references|source)\b/i.test(label);
// A workbook's sheets as rows; an older CSV release is a single sheet.
async function sheetsOf(buffer) {
    if (buffer[0] === 0x50 && buffer[1] === 0x4b) {
        const book = new ExcelJS.Workbook(); await book.xlsx.load(buffer);
        return book.worksheets.map(sheet => ({ name: sheet.name, rows: rowsOf(sheet) }));
    }
    return [{ name: '', rows: parseCsv(decodeText(buffer)) }];
}
const countryName = value => value.trim().replace(/^the\s+/i, '').replace(/^all countries$/i, 'All countries');
const invalid = (message, name) => Object.assign(new Error(`${name || 'I-140 file'}: ${message}`), { status: 400 });

// Quarterly workbook: the summary by quarter, and the latest quarter's state and country tables.
async function parseQuarterly(buffer, name) {
    const sheets = await sheetsOf(buffer);
    const { rows } = sheets.find(item => /summary/i.test(item.name)) || sheets[0];
    const fiscalYear = Number(rows.slice(0, 4).map(row => text(row[0])).join(' ').match(/Fiscal Year (\d{4})/i)?.[1]);
    if (!fiscalYear) throw invalid('fiscal year not found', name);
    const headerIndex = rows.findIndex(row => row.some(cell => /^received/i.test(text(cell))));
    if (headerIndex < 1) throw invalid('Received/Approved/Denied/Pending columns not found', name);
    // Each quarter is a Received/Approved/Denied/Pending group; the fifth group is the fiscal year total.
    // (Quarter labels can sit over any column of their group, so groups are counted instead.)
    let group = 0;
    const columns = rows[headerIndex].map((cell, index) => {
        const measure = text(cell).match(/^(received|approved|denied|pending)/i)?.[1]?.toLowerCase();
        if (measure === 'received') group++;
        return measure && group >= 1 && group <= 4 ? { index, measure, quarter: group } : null;
    }).filter(Boolean);
    const quarters = new Map();
    for (const row of rows.slice(headerIndex + 1)) {
        const label = text(row[0]);
        if (isEnd(label)) break;
        const code = categoryOf(label);
        if (!code) continue;
        for (const column of columns) {
            if (!quarters.has(column.quarter)) quarters.set(column.quarter, {});
            const categories = quarters.get(column.quarter);
            categories[code] = { ...categories[code], [column.measure]: number(row[column.index]) };
        }
    }
    // Quarters not yet reported are all zeros.
    const reported = [...quarters].filter(([, categories]) => categories.all && Object.values(categories.all).some(value => value > 0))
        .map(([quarter, categories]) => ({ fiscalYear, quarter, categories })).sort((a, b) => a.quarter - b.quarter);
    if (!reported.length || !reported[0].categories.all) throw invalid('no reported quarters', name);
    const breakdown = (pattern, label) => {
        const found = sheets.find(item => pattern.test(item.name));
        if (!found) return null;
        const table = found.rows;
        // The header is the row above the total (some sheets merge the label cell across two header rows).
        const head = table.findIndex(row => /^(grand )?total$/i.test(text(row[0]))) - 1;
        if (head < 0 || !new RegExp('^beneficiary ' + label, 'i').test(text(table[head][0]))) return null;
        const codes = table[head].map((cell, index) => index === 0 ? null : /^total$/i.test(text(cell)) ? 'all' : categoryOf(text(cell)));
        const result = [];
        for (const row of table.slice(head + 1)) {
            const place = text(row[0]);
            if (!place || isEnd(place)) break;
            const values = {};
            codes.forEach((code, index) => { if (code) values[code] = number(row[index]); });
            for (const level of ['eb1', 'eb2', 'eb3']) values[level] ??= CATEGORIES.filter(item => item.level === level && item.code !== level).reduce((sum, item) => sum + (values[item.code] || 0), 0);
            result.push({ name: /^(grand )?total$/i.test(place) ? 'Total' : place, values });
        }
        return result;
    };
    const latest = reported.at(-1).quarter;
    return { fiscalYear, quarters: reported, latest: { fiscalYear, quarter: latest,
        states: { receipts: breakdown(/rec.*state/i, 'state'), approvals: breakdown(/app.*state/i, 'state') },
        countries: { receipts: breakdown(/rec.*cob/i, 'country'), approvals: breakdown(/app.*cob/i, 'country') } } };
}

// Petitions by fiscal year filed and their current status: a sheet per country,
// or (older CSV releases) a block per country titled "...Current Status for India".
async function parseCohorts(buffer, name) {
    const blocks = [];
    for (const sheet of await sheetsOf(buffer)) {
        if (sheet.name) { blocks.push({ country: countryName(sheet.name.replace(/\s*(FY\s*)?\d{2,4}\s*$/i, '')), rows: sheet.rows }); continue; }
        for (const row of sheet.rows) {
            const title = text(row[0]).match(/current status for (.+)$/i);
            if (title) blocks.push({ country: countryName(title[1]), rows: [] });
            blocks.at(-1)?.rows.push(row);
        }
    }
    let asOf = null;
    const countries = [];
    for (const { country, rows } of blocks) {
        const title = rows.slice(0, 4).map(row => text(row[0])).join(' ');
        asOf ||= title.match(/(\d{4}) to (\d{4})(?: \((Q\d)\))?/i)?.slice(1).join(' ') || null;
        const headIndex = rows.findIndex(row => row.slice(1).filter(cell => /^\d{4}$/.test(text(cell))).length >= 3);
        if (headIndex < 0) continue;
        const years = rows[headIndex].map((cell, index) => /^\d{4}$/.test(text(cell)) ? { index, year: Number(text(cell)) } : null).filter(Boolean);
        const categories = {}, approvals = {};
        let section = 'all', byCategory = false;
        for (const row of rows.slice(headIndex + 1)) {
            const label = text(row[0]);
            if (isEnd(label)) break;
            if (!label) continue;
            const values = () => years.map(year => number(row[year.index]));
            const code = categoryOf(label);
            if (/^approvals by category/i.test(label)) { byCategory = true; continue; }
            if (['eb1', 'eb2', 'eb3'].includes(code)) { section = code; byCategory = false; continue; }
            if (byCategory && code && code !== 'all') { approvals[code] = values(); continue; }
            const measure = /^(total|total petitions)$/i.test(label) ? 'total' : /^approved/i.test(label) ? 'approved' : /^denied/i.test(label) ? 'denied' : /^pending/i.test(label) ? 'pending' : null;
            if (measure) { if (section) (categories[section] ||= {})[measure] = values(); continue; }
            // Another heading (older reports have "Other and Unknown"): its rows belong to no preference.
            if (!code) { section = null; byCategory = false; }
        }
        if (categories.all?.total && !countries.some(item => item.name === country)) countries.push({ name: country, years: years.map(year => year.year), categories, approvals });
    }
    if (!countries.length) throw invalid('no country sheets with fiscal-year columns', name);
    return { asOf, countries };
}

// Adds filing years the current report no longer includes from earlier reports
// (newest first). Those years show their status as of that report.
function mergeCohortHistory(current, history) {
    const added = new Map();
    for (const country of current.countries) {
        const older = [];
        const years = new Map(country.years.map((year, index) => [year, index]));
        const columns = [...country.years.map(year => ({ year, from: country, index: years.get(year) }))];
        for (const snapshot of history) {
            const match = snapshot.countries.find(item => item.name === country.name);
            if (!match) continue;
            match.years.forEach((year, index) => {
                if (columns.some(column => column.year === year)) return;
                columns.push({ year, from: match, index });
                older.push({ year, source: snapshot.source?.name || null });
                if (!added.has(year)) added.set(year, new Set());
                added.get(year).add(snapshot.source?.name || null);
            });
        }
        columns.sort((a, b) => a.year - b.year);
        // A category an earlier report did not break out (it counted NIW within E21) is unknown, not zero.
        const pick = series => columns.map(column => series(column.from)?.[column.index] ?? null);
        country.years = columns.map(column => column.year);
        for (const [section, measures] of Object.entries(country.categories)) {
            for (const measure of Object.keys(measures)) measures[measure] = pick(from => from.categories[section]?.[measure]);
        }
        for (const code of Object.keys(country.approvals)) country.approvals[code] = pick(from => from.approvals[code]);
        country.older = older.sort((a, b) => a.year - b.year);
    }
    current.history = [...added].sort((a, b) => a[0] - b[0]).map(([year, sources]) => ({ year, sources: [...sources] }));
    return current;
}

// Approved petitions awaiting visa availability, by country and preference.
async function parseAwaiting(buffer, name) {
    const [{ rows }] = await sheetsOf(buffer);
    const asOf = rows.slice(0, 4).map(row => text(row[0])).join(' ').match(/As of ([A-Za-z]+ \d{4})/i)?.[1] || null;
    const headIndex = rows.findIndex(row => /^country/i.test(text(row[0])));
    if (headIndex < 0) throw invalid('country column not found', name);
    const columns = rows[headIndex].map((cell, index) => index && text(cell) ? { index, label: text(cell) } : null).filter(Boolean);
    const countries = [];
    for (const row of rows.slice(headIndex + 1)) {
        const label = text(row[0]);
        if (!label || isEnd(label)) break;
        countries.push({ name: /^total$/i.test(label) ? 'Total' : label, values: columns.map(column => number(row[column.index])) });
    }
    return { asOf, categories: columns.map(column => column.label), countries };
}

// ---------------------------------------------------------------- Sources

const KINDS = {
    quarterly: /i140_fy(\d{4})_q(\d)(?:_v(\d+))?\.xlsx/i,
    cohorts: /i140_rec_by_class_country_fy(\d{4})_q(\d)(?:_v(\d+))?\.xlsx/i,
    awaiting: /eb_i140_i360_i526_performancedata_fy(\d{4})_q(\d)(?:_v(\d+))?\.xlsx/i,
};
// The newest link of each kind on the data page.
function latestLinks(html) {
    const links = [...String(html).matchAll(/href="([^"]+\.xlsx)"/gi)].map(match => new URL(match[1].replace(/&amp;/g, '&'), 'https://www.uscis.gov').href);
    return Object.fromEntries(Object.entries(KINDS).map(([kind, pattern]) => {
        const ranked = links.map(url => ({ url, match: url.split('/').pop().match(pattern) }))
            .filter(item => item.match && item.match.index === 0)
            .map(item => ({ url: item.url, fiscalYear: Number(item.match[1]), quarter: Number(item.match[2]), version: Number(item.match[3] || 0) }))
            .sort((a, b) => b.fiscalYear - a.fiscalYear || b.quarter - a.quarter || b.version - a.version);
        return [kind, ranked[0] || null];
    }));
}

async function fetchBuffer(url, fetcher = fetch) {
    const response = await fetcher(url, { headers: { 'User-Agent': 'LaborLens data import (+https://laborlens.fyi)' }, signal: AbortSignal.timeout(60000) });
    if (!response.ok) throw Object.assign(new Error(`${url}: HTTP ${response.status}`), { status: response.status });
    return Buffer.from(await response.arrayBuffer());
}

// Downloads the latest workbooks, plus each earlier fiscal year's full-year (Q4) file.
async function downloadLatest({ fetcher = fetch, log = () => {} } = {}) {
    const html = (await fetchBuffer(DATA_PAGE, fetcher)).toString('utf8');
    const links = latestLinks(html);
    for (const kind of Object.keys(KINDS)) if (!links[kind]) throw new Error(`No ${kind} I-140 file is linked on ${DATA_PAGE}`);
    const files = { quarterly: [], cohorts: null, awaiting: null };
    for (let year = FIRST_QUARTERLY_YEAR; year < links.quarterly.fiscalYear; year++) {
        let found = null;
        for (const name of [`i140_fy${year}_q4_v1.xlsx`, `i140_fy${year}_q4.xlsx`, ...(OLDER_QUARTERLY[year] || [])]) {
            try { found = { url: FILE_BASE + name, buffer: await fetchBuffer(FILE_BASE + name, fetcher) }; break; } catch (error) { if (error.status !== 404) throw error; }
        }
        if (found) files.quarterly.push(found); else log({ event: 'i140-missing-year', fiscalYear: year });
    }
    files.quarterly.push({ url: links.quarterly.url, buffer: await fetchBuffer(links.quarterly.url, fetcher) });
    files.cohorts = { url: links.cohorts.url, buffer: await fetchBuffer(links.cohorts.url, fetcher) };
    files.awaiting = { url: links.awaiting.url, buffer: await fetchBuffer(links.awaiting.url, fetcher) };
    files.cohortHistory = [];
    for (const url of COHORT_HISTORY) {
        try { files.cohortHistory.push({ url, buffer: await fetchBuffer(url, fetcher) }); } catch (error) { if (error.status !== 404) throw error; log({ event: 'i140-missing-history', url }); }
    }
    return files;
}

async function importI140(db, files) {
    const name = file => file.url ? file.url.split('/').pop() : file.name;
    const quarterly = [];
    for (const file of files.quarterly) quarterly.push({ ...(await parseQuarterly(file.buffer, name(file))), source: { name: name(file), url: file.url || null } });
    quarterly.sort((a, b) => a.fiscalYear - b.fiscalYear);
    const current = quarterly.at(-1);
    const snapshot = {
        _id: DOC_ID,
        quarters: quarterly.flatMap(file => file.quarters),
        latest: current.latest,
        cohorts: mergeCohortHistory({ ...(await parseCohorts(files.cohorts.buffer, name(files.cohorts))), source: { name: name(files.cohorts), url: files.cohorts.url || null } },
            await Promise.all((files.cohortHistory || []).map(async file => ({ ...(await parseCohorts(file.buffer, name(file))), source: { name: name(file), url: file.url || null } })))),
        awaiting: { ...(await parseAwaiting(files.awaiting.buffer, name(files.awaiting))), source: { name: name(files.awaiting), url: files.awaiting.url || null } },
        sources: [...quarterly.map(file => file.source), ...(files.cohortHistory || []).map(file => ({ name: name(file), url: file.url || null }))],
        importedAt: new Date(),
    };
    await db.collection(COLLECTION).replaceOne({ _id: DOC_ID }, snapshot, { upsert: true });
    cached = null;
    return snapshot;
}

let cached = null;
async function getI140(db) {
    if (cached && cached.expires > Date.now()) return cached.value;
    const snapshot = await db.collection(COLLECTION).findOne({ _id: DOC_ID }, { maxTimeMS: 2000 });
    const value = snapshot ? { available: true, categories: CATEGORIES, ...snapshot, _id: undefined } : { available: false, categories: CATEGORIES };
    cached = { value, expires: Date.now() + 5 * 60 * 1000 };
    return value;
}

async function getI140Status(db) {
    const snapshot = await db.collection(COLLECTION).findOne({ _id: DOC_ID }, { projection: { importedAt: 1, latest: { fiscalYear: 1, quarter: 1 }, 'cohorts.asOf': 1, 'awaiting.asOf': 1, sources: 1, 'cohorts.source': 1, 'awaiting.source': 1 }, maxTimeMS: 2000 });
    return snapshot ? { importedAt: snapshot.importedAt, fiscalYear: snapshot.latest.fiscalYear, quarter: snapshot.latest.quarter,
        sources: [...snapshot.sources, snapshot.cohorts.source, snapshot.awaiting.source] } : null;
}

module.exports = { CATEGORIES, categoryOf, parseQuarterly, parseCohorts, mergeCohortHistory, parseAwaiting, latestLinks, downloadLatest, importI140, getI140, getI140Status,
    clearI140Cache: () => { cached = null; } };
