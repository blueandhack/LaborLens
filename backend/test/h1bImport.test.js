const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const ExcelJS = require('exceljs');
const { discoverDatasets } = require('../services/dolSource');
const { auditWorkbook, importWorkbook } = require('../services/importWorkbook');

test('H-1B discovery selects the newest cumulative LCA main file only, including DOL spelling variants', () => {
    const names = ['LCA_Disclosure_Data_FY2026_Q2.xlsx', 'LCA_Dislclosure_Data_FY2026_Q3.xlsx',
        'LCA_Appendix_A_FY2026_Q3.xlsx', 'LCA_Worksites_FY2026_Q3.xlsx', 'LCA_Record_Layout_FY2026_Q3.pdf'];
    const files = discoverDatasets(names.map(name => `<a href="/media/${name}">file</a>`).join(''), { programs: ['h1b'] });
    assert.equal(files.length, 1);
    assert.equal(files[0].type, 'h1b'); assert.equal(files[0].quarter, 3);
    assert.throws(() => discoverDatasets('', { programs: ['h1b'] }), /no supported H1B/);
    assert.throws(() => discoverDatasets('', { programs: ['other'] }), /Invalid disclosure programs/);
});

test('H-1B importer excludes H-1B1/E-3, retains wage periods and variants, and rejects uncertain visa classes before writes', async t => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'laborlens-h1b-test-'));
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    const file = path.join(directory, 'h1b.xlsx');
    const workbook = new ExcelJS.Workbook(); const sheet = workbook.addWorksheet('LCA');
    sheet.addRow(['CASE_NUMBER', 'CASE_STATUS', 'VISA_CLASS', 'EMPLOYER_NAME', 'EMPLOYER_CITY', 'EMPLOYER_STATE',
        'JOB_TITLE', 'SOC_CODE', 'DECISION_DATE', 'RECEIVED_DATE', 'WAGE_RATE_OF_PAY_FROM', 'WAGE_RATE_OF_PAY_TO',
        'WAGE_UNIT_OF_PAY', 'TOTAL_WORKER_POSITIONS', 'WORKSITE_CITY']);
    const base = ['I-200-26001-000001', 'Certified-Withdrawn', 'H-1B', 'Example LLC', 'Austin', 'TX',
        'Software Engineer', '15-1252', new Date('2026-02-01'), new Date('2026-01-01'), '120,000', 150000, 'Year', 5, 'Dallas'];
    sheet.addRow(base); sheet.addRow([...base.slice(0, 14), 'Houston']);
    sheet.addRow(['I-200-26001-000002', 'Certified', 'H-1B1 Chile', ...base.slice(3)]);
    sheet.addRow(['I-200-26001-000003', 'Certified', 'E-3 Australian', ...base.slice(3)]);
    sheet.addRow(['I-200-26001-000004', 'Denied', 'H1B', ...base.slice(3, 10), '60.50', null, 'Hour', 1, 'Dallas']);
    await workbook.xlsx.writeFile(file);
    const audit = await auditWorkbook(file, { type: 'h1b' });
    assert.equal(audit.report.uniqueCases, 2); assert.equal(audit.report.excludedRows, 2);
    assert.equal(audit.report.duplicateRows, 1);
    const rows = [];
    const Model = { bulkWrite: async operations => { rows.push(...operations.map(op => op.updateOne.update.$set)); return { upsertedCount: operations.length }; } };
    const stats = await importWorkbook(file, { type: 'h1b', Model, validation: audit });
    assert.equal(stats.inserted, 2);
    const first = rows.find(row => row.CASE_NUMBER === base[0]);
    assert.equal(first.WAGE_RATE_OF_PAY_FROM, 120000); assert.equal(first.WAGE_UNIT_OF_PAY, 'Year');
    assert.equal(first.TOTAL_WORKER_POSITIONS, 5); assert.equal(first.PWD_SOC_CODE, '15-1252');
    assert.equal(first.EMPLOYER_NAME_LOWER, 'example llc'); assert.equal(first.EMPLOYER_CITY_LOWER, 'austin');
    assert.equal(first.DECISION_DATE.toISOString(), '2026-02-01T00:00:00.000Z');
    assert.equal(first._DOL_ALTERNATE_RECORDS.length, 1);
    assert.equal(rows.find(row => row.CASE_NUMBER.endsWith('4')).WAGE_RATE_OF_PAY_FROM, 60.5);
    sheet.addRow(['I-200-26001-000005', 'Certified', null, ...base.slice(3)]);
    await workbook.xlsx.writeFile(file);
    await assert.rejects(importWorkbook(file, { type: 'h1b', Model: { bulkWrite: () => assert.fail('must not write') } }), /without VISA_CLASS/);
});

test('US employer province Excel errors resolve as not applicable while the original error remains auditable', async t => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'laborlens-province-test-'));
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    const file = path.join(directory, 'province.xlsx');
    const workbook = new ExcelJS.Workbook(); const sheet = workbook.addWorksheet('LCA');
    sheet.addRow(['CASE_NUMBER','VISA_CLASS','EMPLOYER_NAME','EMPLOYER_COUNTRY','EMPLOYER_STATE','EMPLOYER_PROVINCE','WAGE_RATE_OF_PAY_FROM','DECISION_DATE']);
    sheet.addRow(['I-1','H-1B','US employer','UNITED STATES OF AMERICA','MI',{error:'#NAME?'},100000,46023]);
    sheet.addRow(['I-2','H-1B','Foreign employer','CANADA',null,{error:'#NAME?'},100000,46023]);
    sheet.addRow(['I-3','H-1B','Incomplete address','USA',null,{error:'#NAME?'},100000,46023]);
    await workbook.xlsx.writeFile(file);
    const audit = await auditWorkbook(file,{type:'h1b'});
    assert.equal(audit.report.issues['EMPLOYER_PROVINCE:excel_error'],3);
    assert.equal(audit.report.resolvedIssues['EMPLOYER_PROVINCE:excel_error'],1);
    const writes=[];
    await importWorkbook(file,{type:'h1b',validation:audit,Model:{bulkWrite:async batch=>{writes.push(...batch);return {}}}});
    const records=writes.map(write=>write.updateOne.update.$set);
    assert.equal(records[0].EMPLOYER_PROVINCE,null);
    assert.equal(records[0]._DOL_CELL_ERRORS.EMPLOYER_PROVINCE,'#NAME?');
    assert.equal(records[0]._DOL_CELL_RESOLUTIONS.EMPLOYER_PROVINCE.originalValue,'#NAME?');
    assert.equal(records[1]._DOL_CELL_RESOLUTIONS,undefined);
    assert.equal(records[2]._DOL_CELL_RESOLUTIONS,undefined);
});


test('H-1B archive discovery includes every annual naming scheme and both independent 2009 releases', () => {
    const names = ['H-1B_Case_Data_FY2008.xlsx', 'Icert_ LCA_ FY2009.xlsx', 'H-1B_Case_Data_FY2009.xlsx',
        'H-1B_FY2010.xlsx', 'H-1B_iCert_LCA_FY2011_Q4.xlsx', 'LCA_FY2012_Q4.xlsx', 'LCA_FY2013.xlsx',
        'H-1B_FY14_Q4.xlsx', 'H-1B_Disclosure_Data_FY15_Q4.xlsx', 'H-1B_Disclosure_Data_FY16.xlsx',
        'H-1B_Disclosure_Data_FY17.xlsx', 'H-1B_Disclosure_Data_FY2018_EOY.xlsx', 'H-1B_Disclosure_Data_FY2019.xlsx',
        'LCA_Disclosure_Data_FY2020_Q4.xlsx', 'LCA_Disclosure_Data_FY2020_Q2.xlsx', 'LCA_Worksites_FY2020_Q4.xlsx'];
    const files = discoverDatasets(names.map(name => `<a href="/media/${name}">file</a>`).join(''), { programs: ['h1b'], fromYear: 2008 });
    assert.equal(files.length, 14);
    assert.equal(files.filter(file => file.fiscalYear === 2009).length, 2);
    assert.deepEqual([...new Set(files.map(file => file.fiscalYear))].sort(), Array.from({length:13}, (_, i) => 2008 + i).sort());
    assert.ok(files.every(file => file.type === 'h1b'));
    assert.equal(files.find(file => file.fiscalYear === 2020).quarter, 4);
});

async function legacyFixture(t, headers, rows) {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'laborlens-h1b-legacy-'));
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    const file = path.join(directory, 'legacy.xlsx');
    const book = new ExcelJS.Workbook();book.addWorksheet('LCA').addRows([headers,...rows]);
    await book.xlsx.writeFile(file);return file;
}

test('FY2008 program codes, employer columns and first-location wages map without losing original second-location fields', async t => {
    const headers=['CASE_NO','PROGRAM','NAME','CITY','STATE','POSTAL_CODE','SUBMITTED_DATE','DOL_DECISION_DATE','APPROVAL_STATUS','JOB_TITLE','WAGE_RATE_1','MAX_RATE_1','RATE_PER_1','NBR_IMMIGRANTS','CITY_1','STATE_1','WAGE_RATE_2','JOB_CODE'];
    const row=['I-08090-4182485','R','Legacy employer','Wixom','MI','48393',39537,39538,'CERTIFIED','Engineer',50000,null,'yr',2,'Detroit','MI',60000,'030'];
    const file=await legacyFixture(t,headers,[row,[...row.slice(0,1).map(()=> 'E-1'),'A',...row.slice(2)]]);
    const validation=await auditWorkbook(file,{type:'h1b'});
    assert.equal(validation.report.uniqueCases,1);assert.equal(validation.report.excludedRows,1);
    const writes=[];await importWorkbook(file,{type:'h1b',validation,Model:{bulkWrite:async batch=>{writes.push(...batch);return {}}}});
    const record=writes[0].updateOne.update.$set;
    assert.equal(record.EMPLOYER_NAME,'Legacy employer');assert.equal(record.EMPLOYER_CITY_LOWER,'wixom');
    assert.equal(record.VISA_CLASS,'H-1B');assert.equal(record.PROGRAM,'R');
    assert.equal(record.WAGE_UNIT_OF_PAY,'Year');assert.equal(record.WAGE_RATE_OF_PAY_FROM,50000);
    assert.equal(record.WAGE_RATE_2,60000);assert.equal(record.TOTAL_WORKER_POSITIONS,2);
    assert.equal(record.PWD_SOC_CODE,null);assert.equal(record.JOB_CODE,'030');
    assert(record.RECEIVED_DATE instanceof Date);assert(record.DECISION_DATE instanceof Date);
});

test('iCERT aliases preserve wage periods and original source fields; missing visa columns prevent writes', async t => {
    const headers=['LCA_CASE_NUMBER','VISA_CLASS','LCA_CASE_EMPLOYER_NAME','LCA_CASE_JOB_TITLE','LCA_CASE_EMPLOYER_CITY','LCA_CASE_SUBMIT','DECISION_DATE','LCA_CASE_WAGE_RATE_FROM','LCA_CASE_WAGE_RATE_TO','LCA_CASE_WAGE_RATE_UNIT','LCA_CASE_SOC_CODE'];
    const file=await legacyFixture(t,headers,[['I-200-1','R','iCERT employer','Engineer','Raleigh',39940,39941,28,32,'Hour','17-2071.00']]);
    const writes=[];await importWorkbook(file,{type:'h1b',Model:{bulkWrite:async batch=>{writes.push(...batch);return {}}}});
    const record=writes[0].updateOne.update.$set;
    assert.equal(record.CASE_NUMBER,'I-200-1');assert.equal(record.WAGE_UNIT_OF_PAY,'Hour');
    assert.equal(record.WAGE_RATE_OF_PAY_FROM,28);assert.equal(record.PWD_SOC_CODE,'17-2071.00');
    assert.equal(record.LCA_CASE_WAGE_RATE_UNIT,'Hour');assert.equal(record.EMPLOYER_NAME_LOWER,'icert employer');
    const incomplete=await legacyFixture(t,headers.filter(field=>field!=='VISA_CLASS'),[['I-200-2','Unclassified','Engineer','Raleigh',39940,39941,28,32,'Hour','17-2071.00']]);
    await assert.rejects(importWorkbook(incomplete,{type:'h1b',Model:{bulkWrite:()=>assert.fail('must not import an unknown visa class')}}),/missing required columns: VISA_CLASS/);
});

test('FY2015 explicit wage-range strings split into bounds without annualizing or inventing a missing bound', async t => {
    const headers=['CASE_NUMBER','CASE_STATUS','VISA_CLASS','EMPLOYER_NAME','DECISION_DATE','WAGE_RATE_OF_PAY','WAGE_UNIT_OF_PAY','CASE_SUBMITTED'];
    const file=await legacyFixture(t,headers,[['I-1','CERTIFIED','H-1B','Employer',42040,'60,000.00 - 85,000.00','Year',42000],['I-2','CERTIFIED','H-1B','Employer',42040,'28.50 -','Hour',42000]]);
    const writes=[];await importWorkbook(file,{type:'h1b',Model:{bulkWrite:async batch=>{writes.push(...batch);return {}}}});
    const [first,second]=writes.map(write=>write.updateOne.update.$set);
    assert.equal(first.WAGE_RATE_OF_PAY_FROM,60000);assert.equal(first.WAGE_RATE_OF_PAY_TO,85000);
    assert.equal(first.WAGE_RATE_OF_PAY,'60,000.00 - 85,000.00');assert(first.RECEIVED_DATE instanceof Date);
    assert.equal(second.WAGE_RATE_OF_PAY_FROM,28.5);assert.equal(second.WAGE_RATE_OF_PAY_TO,null);assert.equal(second.WAGE_UNIT_OF_PAY,'Hour');
});

test('FY2019 first-worksite fields map while all additional worksite data is retained', async t => {
    const file=await legacyFixture(t,['CASE_NUMBER','VISA_CLASS','EMPLOYER_NAME','DECISION_DATE','WAGE_RATE_OF_PAY_FROM_1','WAGE_RATE_OF_PAY_TO_1','WAGE_UNIT_OF_PAY_1','WORKSITE_CITY_1','WORKSITE_CITY_2','WAGE_RATE_OF_PAY_FROM_2'],[['I-1','H-1B','Employer',43500,40,50,'Hour','Boston','Austin',55]]);
    const writes=[];await importWorkbook(file,{type:'h1b',Model:{bulkWrite:async batch=>{writes.push(...batch);return {}}}});
    const record=writes[0].updateOne.update.$set;
    assert.equal(record.WAGE_RATE_OF_PAY_FROM,40);assert.equal(record.WAGE_UNIT_OF_PAY,'Hour');
    assert.equal(record.WORKSITE_CITY,'Boston');assert.equal(record.WORKSITE_CITY_2,'Austin');assert.equal(record.WAGE_RATE_OF_PAY_FROM_2,55);
});

test('only the fingerprinted official FY2010 source recovers known iCERT program IDs with recorded provenance', async t => {
    const { FY2010_SHA256 } = require('../services/h1bSourceRules');
    const source={type:'h1b',fiscalYear:2010,quarter:4,url:'https://www.dol.gov/sites/dolgov/files/ETA/oflc/pdfs/H-1B_FY2010.xlsx',sha256:FY2010_SHA256};
    const headers=['LCA_CASE_NUMBER','STATUS','LCA_CASE_EMPLOYER_NAME','DECISION_DATE','LCA_CASE_WAGE_RATE_FROM'];
    const file=await legacyFixture(t,headers,[['I-200-09198-587210','CERTIFIED','Employer',40014,51022],['I-203-09198-587211','CERTIFIED','Employer',40014,51022]]);
    await assert.rejects(auditWorkbook(file,{type:'h1b'}),/missing required columns: VISA_CLASS/);
    await assert.rejects(auditWorkbook(file,{type:'h1b',source:{...source,sha256:'changed'}}),/missing required columns: VISA_CLASS/);
    await assert.rejects(auditWorkbook(file,{type:'h1b',source:{...source,url:'https://example.com/unverified.xlsx'}}),/missing required columns: VISA_CLASS/);
    const audit=await auditWorkbook(file,{type:'h1b',source});
    assert.equal(audit.report.uniqueCases,1);assert.equal(audit.report.excludedRows,1);
    assert.equal(audit.report.derivedFields.VISA_CLASS,1);
    const writes=[];await importWorkbook(file,{type:'h1b',source,validation:audit,Model:{bulkWrite:async batch=>{writes.push(...batch);return {}}}});
    const record=writes[0].updateOne.update.$set;
    assert.equal(record.VISA_CLASS,'H-1B');assert.equal(record.WAGE_UNIT_OF_PAY,null);
    assert.equal(record._DOL_DERIVED_FIELDS.VISA_CLASS.sourceValue,'I-200-09198-587210');
    const unknown=await legacyFixture(t,headers,[['I-999-09198-587210','CERTIFIED','Employer',40014,51022]]);
    await assert.rejects(importWorkbook(unknown,{type:'h1b',source,Model:{bulkWrite:()=>assert.fail('unknown case numbers must never write')}}),/unrecognized iCERT case number/);
});
