const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const { createHash } = require('crypto');
const { dolURL, discoverDatasets, requestDOL, downloadDataset } = require('../services/dolSource');

const url = 'https://www.dol.gov/media/PW_Disclosure_Data_FY2026_Q3.xlsx';
const dataset = { url };
const html = `
    <a href="/media/PW_Disclosure_Data_FY2026_Q2.xlsx">Old quarter</a>
    <a href="${url}">Current PWD</a>
    <a href="/media/PW_Worksites_FY2026_Q3.xlsx">Worksites</a>
    <a href="/media/PERM_Disclosure_Data_FY2025_Q4.xlsx">PERM</a>
    <a href="/media/PERM_Disclosure_Data_New_Form_FY2025_Q4.xlsx">New form</a>
    <a href="/media/PERM_Record_Layout_FY2025.pdf">Layout</a>
    <a href="https://example.org/PW_Disclosure_Data_FY2028.xlsx">Untrusted</a>
    <a href="/media/LCA_Disclosure_Data_FY2026_Q3.xlsx">LCA</a>`;

test('discovery selects newest cumulative release per program and retains both form variants', () => {
    const files = discoverDatasets(html);
    assert.equal(files.length, 3);
    assert.equal(files[0].url, url);
    assert.equal(files[0].fiscalYear, 2026);
    assert.equal(files[0].quarter, 3);
    assert.deepEqual(files.map(file => file.type), ['pwd', 'perm', 'perm']);
    const annual = discoverDatasets(html + '<a href="/media/PW_Disclosure_Data_FY2026.xlsx">Annual</a>');
    assert.equal(annual[0].quarter, 4);
    assert.equal(annual[0].filename, 'PW_Disclosure_Data_FY2026.xlsx');
});

test('discovery fails loudly if a program disappears or page is a challenge page', () => {
    assert.throws(() => discoverDatasets('<html>Access denied</html>'), /no supported PWD/);
    assert.throws(() => discoverDatasets(`<a href="${url}">PWD</a>`), /no supported PERM/);
});

test('download URLs reject other hosts, plaintext, credentials, and nonstandard ports', () => {
    for (const value of ['http://www.dol.gov/a', 'https://dol.gov.evil.org/a', 'https://x@dol.gov/a', 'https://dol.gov:8443/a']) {
        assert.throws(() => dolURL(value), /Only HTTPS/);
    }
    assert.equal(dolURL('/media/test.xlsx'), 'https://www.dol.gov/media/test.xlsx');
});

test('redirect destinations are validated before fetching them', async t => {
    const original = global.fetch;
    t.after(() => { global.fetch = original; });
    let calls = 0;
    global.fetch = async () => { calls++; return new Response(null, { status: 302, headers: { location: 'https://evil.org/a.xlsx' } }); };
    await assert.rejects(requestDOL(url), /Only HTTPS/);
    assert.equal(calls, 1);
});

test('downloads support conditional requests, content hashes, and forced replay', async t => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'laborlens-download-test-'));
    const original = global.fetch;
    t.after(async () => { global.fetch = original; await fs.rm(dir, { recursive: true, force: true }); });
    const bytes = Buffer.from([0x50, 0x4b, 0x03, 0x04, 1, 2, 3]);
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    global.fetch = async (target, options) => {
        assert.equal(options.headers['If-None-Match'], 'v1');
        return new Response(null, { status: 304 });
    };
    assert.deepEqual(await downloadDataset(dataset, path.join(dir, 'none'), { sha256, etag: 'v1' }), { unchanged: true });
    global.fetch = async () => new Response(bytes, { headers: { etag: 'v2' } });
    const same = await downloadDataset(dataset, path.join(dir, 'same'), { sha256 });
    assert.equal(same.unchanged, true);
    assert.equal(same.bytes, 7);
    global.fetch = async (target, options) => {
        assert.equal(options.headers['If-None-Match'], undefined);
        return new Response(bytes, { headers: { etag: 'v2' } });
    };
    const forced = await downloadDataset(dataset, path.join(dir, 'forced'), { sha256, etag: 'v1' }, { force: true });
    assert.equal(forced.unchanged, false);
});

test('HTML errors and oversized responses are rejected as workbooks', async t => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'laborlens-invalid-download-'));
    const original = global.fetch;
    t.after(async () => { global.fetch = original; await fs.rm(dir, { recursive: true, force: true }); });
    global.fetch = async () => new Response('<html>Denied</html>');
    await assert.rejects(downloadDataset(dataset, path.join(dir, 'html')), /not an XLSX/);
    global.fetch = async () => new Response('x', { headers: { 'content-length': String(1024 ** 3) } });
    await assert.rejects(downloadDataset(dataset, path.join(dir, 'huge')), /size limit/);
});

test('coverage inventory includes superseded quarterly snapshots without changing the import selection', () => {
    const selected = discoverDatasets(html);
    const inventory = discoverDatasets(html, { allReleases: true });
    assert.equal(selected.filter(file => file.type === 'pwd').length, 1);
    assert.equal(inventory.filter(file => file.type === 'pwd').length, 2);
    assert.equal(inventory.filter(file => file.type === 'perm').length, 2, 'both form variants remain part of the release');
    assert.ok(inventory.every(file => !/Worksites|Record_Layout/.test(file.filename)));
});

test('historical H-1B Q4 does not supersede Q1 to Q3 while a current cumulative release can', () => {
    const link = name => `<a href="/media/${name}">file</a>`;
    const page = 'Latest Quarterly Updates' + link('LCA_Disclosure_Data_FY2026_Q3.xlsx') + 'Historical Case Disclosure Data'
        + [2020, 2025].flatMap(year => [1, 2, 3, 4].map(q => link(`LCA_Disclosure_Data_FY${year}_Q${q}.xlsx`))).join('');
    const targets = discoverDatasets(page, { programs: ['h1b'], fromYear: 2008 });
    assert.equal(targets.length, 9);
    assert.equal(targets.filter(file => file.fiscalYear === 2025).length, 4);
    assert.equal(targets.find(file => file.fiscalYear === 2026).coverageMode, 'cumulative');
    assert.ok(targets.filter(file => file.fiscalYear !== 2026).every(file => file.coverageMode === 'quarterly'));
    // Without an explicit current-release declaration, quarter files are
    // conservative independent targets rather than guessed cumulative data.
    assert.equal(discoverDatasets([1, 2, 3].map(q => link(`LCA_Disclosure_Data_FY2026_Q${q}.xlsx`)).join(''), { programs: ['h1b'] }).length, 3);
});
