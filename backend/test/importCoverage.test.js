const { test } = require('node:test');
const assert = require('node:assert/strict');
const { buildImportCoverage } = require('../services/importCoverage');
const file = (quarter, extra = {}) => ({ type: 'h1b', fiscalYear: 2021, quarter, filename: `LCA_Disclosure_Data_FY2021_Q${quarter}.xlsx`, url: `https://www.dol.gov/q${quarter}.xlsx`, ...extra });
const done = source => ({ ...source, status: 'done', validation: { version: 2, uniqueCases: 100 } });
const build = (datasets, sources = [], releases = datasets, active = null) => buildImportCoverage({ catalog: { fromYear: 2021, datasets, releases }, sources, active, validationVersion: 2 });
const h1b = result => result.programs.find(program => program.type === 'h1b');

test('later cumulative quarters cover earlier snapshots without claiming those files were imported', () => {
    const files = [file(1), file(2), file(3), file(4)];
    const program = h1b(build([files[3]], [done(files[3])], files));
    assert.equal(program.totalFiles, 1);
    assert.equal(program.percentage, 100);
    assert.deepEqual(program.years[0].quarters.map(cell => cell.state), ['covered', 'covered', 'covered', 'imported']);
    assert.equal(program.years[0].quarters[0].viaQuarter, 4);
    assert.equal(program.files.find(source => source.quarter === 1).status, 'pending');
    assert.equal(program.files.find(source => source.quarter === 1).required, false);
});

test('a separately imported Q1 remains directly imported even when Q4 is also complete', () => {
    const files = [file(1), file(4)];
    const program = h1b(build([files[1]], files.map(done), files));
    assert.equal(program.years[0].quarters[0].state, 'imported');
});

test('both independent annual 2009 files must finish before annual coverage is complete', () => {
    const files = [file(4, { filename: 'H-1B_Case_Data_FY2009.xlsx', fiscalYear: 2009 }), file(4, { filename: 'Icert_ LCA_ FY2009.xlsx', fiscalYear: 2009, url: 'https://www.dol.gov/icert.xlsx' })];
    const partial = h1b(build(files, [done(files[0])]));
    assert.equal(partial.completedFiles, 1);
    assert.equal(partial.totalFiles, 2);
    assert(partial.years.find(row => row.fiscalYear === 2009).quarters.every(cell => cell.state === 'partial'));
    const full = h1b(build(files, files.map(done)));
    assert(full.years.find(row => row.fiscalYear === 2009).quarters.every(cell => cell.state === 'covered' && cell.viaAnnual));
});

test('Q3 never covers Q4 and unlisted years do not count as failed or queued files', () => {
    const program = h1b(build([file(3)], [done(file(3))]));
    assert.equal(program.years[0].quarters[3].state, 'unavailable');
    assert.equal(program.attentionFiles, 0);
    assert.equal(program.pendingFiles, 0);
});

test('live row percentages use unique cases and expired or unrelated leases cannot display running forever', () => {
    const source = { ...file(4), status: 'importing', runId: 'run', progress: { processed: 25 }, validation: { version: 2, uniqueCases: 100 } };
    const live = h1b(build([file(4)], [source], [file(4)], { runId: 'run' }));
    assert.equal(live.current[0].percentage, 25);
    assert.equal(live.current[0].total, 100);
    const stale = h1b(build([file(4)], [source]));
    assert.equal(stale.state, 'attention');
    assert.equal(stale.current.length, 0);
    const validating = h1b(build([file(4)], [{ ...source, status: 'validating', validationProgress: { rows: 200 } }], [file(4)], { runId: 'run' }));
    assert.equal(validating.current[0].percentage, null);
    assert.equal(validating.current[0].processed, 200);
});

test('current published inventory advances targets beyond a stale selected catalog and rejects obsolete validation', () => {
    const program = h1b(build([file(3)], [done(file(3)), { ...file(4), status: 'done', validation: { version: 1 } }], [file(3), file(4)]));
    assert.equal(program.totalFiles, 1);
    assert.equal(program.completedFiles, 0);
    assert.equal(program.percentage, 0);
    assert.equal(program.years[0].quarters[2].state, 'imported');
    assert.equal(program.years[0].quarters[3].state, 'pending');
});

test('unknown program inventory is not presented as 100 percent complete', () => {
    const result = buildImportCoverage({ sources: [done(file(4))], validationVersion: 2 });
    const program = h1b(result);
    assert.equal(program.inventoryKnown, false);
    assert.equal(program.totalFiles, null);
    assert.equal(program.percentage, null);
    const pwd = result.programs.find(item => item.type === 'pwd');
    assert(pwd.years[0].quarters.every(cell => cell.state === 'unknown'));
});
