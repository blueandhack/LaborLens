const { test } = require('node:test');
const assert = require('node:assert/strict');
const ExcelJS = require('exceljs');
const { categoryOf, parseQuarterly, parseCohorts, parseAwaiting, mergeCohortHistory, latestLinks, downloadLatest } = require('../services/i140');

const book = async sheets => {
    const workbook = new ExcelJS.Workbook();
    for (const [name, rows] of Object.entries(sheets)) { const sheet = workbook.addWorksheet(name); rows.forEach(row => sheet.addRow(row)); }
    return Buffer.from(await workbook.xlsx.writeBuffer());
};
const SUBS = ['Alien of Extraordinary Ability (E11)', 'Outstanding Professor or Researcher (E12)', 'Multi-national Executive or Manager (E13)', 'Professionals with Advanced Degrees (E21)',
    'National Interest Waiver (NIW)', 'Skilled Worker (E31)', 'Professionals with Baccalaureate Degrees (E32)', 'Unskilled Workers (EW3)'];

// The layout of i140_fyYYYY_qN.xlsx: four quarters plus a total, with a quarter not yet reported.
async function quarterlyFile(fiscalYear) {
    const quarters = ['1st Quarter', '2nd Quarter', '3rd Quarter', '4th Quarter', 'Fiscal Year Total'].flatMap(label => Array(4).fill(label));
    const measures = Array(5).fill(['Received1', 'Approved2', 'Denied3', 'Pending4']).flat();
    const line = (label, q1, q2) => [label, ...q1, ...q2, 0, 0, 0, 0, 0, 0, 0, 0, ...q1.map((value, i) => value + q2[i])];
    const breakdown = (label, total, india) => [['Form I-140'], [`Receipts by Beneficiary ${label}`], [`Fiscal Year ${fiscalYear} (Q2)`],
        [`Beneficiary ${label}`, ...Array(8).fill('First Preference (EB1)')], [`Beneficiary ${label}`, ...SUBS, 'Total'],
        ['Grand Total', ...total, total.reduce((a, b) => a + b, 0)], [india ? 'INDIA' : 'California', ...total.map(value => value - 1), total.reduce((a, b) => a + b, 0) - 8], ['Notes:'], ['1) ...']];
    return book({
        'RADP Summary': [['Form I-140 Immigrant Petition for Alien Worker'], ['By Fiscal Year, Quarter, and Case Status'], [`Fiscal Year ${fiscalYear} (Q1-Q4)`],
            ['', ...quarters], ['', ...measures],
            line('TOTAL', [100, 80, 10, 500], [120, 90, '-', 530]),
            line('First Preference (EB1)', [30, 20, 5, 100], [40, 25, 0, 115]),
            line('National Interest Waiver (NIW)', [20, 5, 4, 90], [25, 6, 3, 106]),
            line('Needed Unskilled Workers (EW3)', [5, 4, 0, 10], [6, 5, 0, 11]),
            ['Table Key:'], ['N/A', 'Not available']],
        'Rec-State': breakdown('State', [10, 2, 3, 4, 5, 6, 7, 8]),
        'App-COB': breakdown('Country of Birth', [3, 2, 3, 4, 5, 6, 7, 8], true),
    });
}

test('categories are read from their codes or names', () => {
    assert.equal(categoryOf('Unskilled Workers (EW3)'), 'eb3u');
    assert.equal(categoryOf('Needed Unskilled Workers'), 'eb3u', 'not "skilled worker"');
    assert.equal(categoryOf('Indiv w/Adv Deg or Exceptional Ability in the National Interest (NIW)'), 'niw');
    assert.equal(categoryOf('Mem of Profession w/Adv Deg, or of Exceptional Ability (E21)'), 'eb2a');
    assert.equal(categoryOf('Grand Total'), 'all');
    assert.equal(categoryOf('Unknown'), null);
});

test('quarterly workbooks: reported quarters, and the latest quarter by state and country', async () => {
    const parsed = await parseQuarterly(await quarterlyFile(2026), 'i140_fy2026_q2_v1.xlsx');
    assert.equal(parsed.fiscalYear, 2026);
    assert.deepEqual(parsed.quarters.map(quarter => quarter.quarter), [1, 2], 'quarters with only zeros are not yet reported');
    assert.deepEqual(parsed.quarters[1].categories.all, { received: 120, approved: 90, denied: 0, pending: 530 });
    assert.deepEqual(parsed.quarters[0].categories.eb3u, { received: 5, approved: 4, denied: 0, pending: 10 });
    assert.equal(parsed.latest.quarter, 2);
    const [total, california] = parsed.latest.states.receipts;
    assert.deepEqual([total.name, total.values.all, total.values.eb1, total.values.eb2, total.values.eb3], ['Total', 45, 15, 9, 21]);
    assert.equal(california.name, 'California');
    assert.equal(parsed.latest.countries.approvals[1].name, 'INDIA', 'a header label merged across two rows is handled');
    assert.equal(parsed.latest.states.approvals, null, 'a missing sheet is reported as missing');
});

test('petitions by year filed and the visa queue', async () => {
    const years = [2024, 2025, 2026];
    const sheet = country => [['Number of Form I-140'], ['By Fiscal Year Received and Current Status'], ['Fiscal Years 2024 to 2026 (Q3)'],
        ['Petitions by Employment Preference', ...years, 'TOTAL'],
        ['TOTAL', 10, 20, 30, 60], ['Approved', 8, 15, 10, 33], ['Denied', 2, 3, 1, 6], ['Pending, Other1', 0, 2, 19, 21],
        ['First Preference (EB1)'], ['Total Petitions', 5, 6, 7, 18], ['Approved', 4, 5, 2, 11], ['Denied', 1, 1, 0, 2], ['Pending, Other1', 0, 0, 5, 5],
        ['Approvals by Category'], ['Aliens with Extraordinary Ability (E11)', 1, 2, 1, 4], ['Table Key:']];
    const cohorts = await parseCohorts(await book({ 'All Countries FY26': sheet(), 'India FY26': sheet() }), 'cohorts.xlsx');
    assert.equal(cohorts.asOf, '2024 2026 Q3');
    assert.deepEqual(cohorts.countries.map(country => country.name), ['All countries', 'India']);
    assert.deepEqual(cohorts.countries[0].years, years);
    assert.deepEqual(cohorts.countries[0].categories.eb1, { total: [5, 6, 7], approved: [4, 5, 2], denied: [1, 1, 0], pending: [0, 0, 5] });
    assert.deepEqual(cohorts.countries[0].approvals.eb1a, [1, 2, 1]);

    const awaiting = await parseAwaiting(await book({ Sheet: [['Number of Form I-140, I-360, I-526/E Approved'], ['By Preference Category and Country of Birth'], ['As of June 2026'],
        ['Country', '1st (Priority)', '2nd (Advanced\nDegree Professional)', 'TOTAL'], ['TOTAL', 3, 7, 10], ['India', 2, 6, 8], ['Table Key:']] }), 'awaiting.xlsx');
    assert.equal(awaiting.asOf, 'June 2026');
    assert.deepEqual(awaiting.categories, ['1st (Priority)', '2nd (Advanced Degree Professional)', 'TOTAL']);
    assert.deepEqual(awaiting.countries, [{ name: 'Total', values: [3, 7, 10] }, { name: 'India', values: [2, 6, 8] }]);
});

test('the latest workbooks are found on the data page; earlier years use their full-year file', async () => {
    const html = ['i140_fy2026_q2_v1.xlsx', 'i140_fy2026_q3_v1.xlsx', 'i140_fy2026_q3_v2.xlsx', 'i140_rec_by_class_country_fy2026_q3_v1.xlsx', 'eb_i140_i360_i526_performancedata_fy2026_q3_v1.xlsx']
        .map(name => `<a href="/sites/default/files/document/data/${name}">x</a>`).join('');
    const links = latestLinks(html);
    assert.equal(links.quarterly.url, 'https://www.uscis.gov/sites/default/files/document/data/i140_fy2026_q3_v2.xlsx');
    assert.equal(links.cohorts.fiscalYear, 2026);
    const requested = [];
    const fetcher = async url => {
        requested.push(url.split('/').pop());
        if (url.endsWith('immigration-and-citizenship-data')) return new Response(html);
        // FY2024 is published without "_v1"; FY2022 and FY2023 only as CSV.
        if (/i140_fy2024_q4_v1\.xlsx|i140_fy202[23]_q4(_v1)?\.xlsx/.test(url)) return new Response('', { status: 404 });
        return new Response('xlsx');
    };
    const files = await downloadLatest({ fetcher });
    assert.deepEqual(files.quarterly.map(file => file.url.split('/').pop()),
        ['I140_FY22_Q4_RADP.csv', 'i140_fy23_q4_radp.csv', 'i140_fy2024_q4.xlsx', 'i140_fy2025_q4_v1.xlsx', 'i140_fy2026_q3_v2.xlsx']);
    assert.ok(requested.includes('i140_fy2024_q4_v1.xlsx'));
    assert.deepEqual(files.cohortHistory.map(file => file.url.split('/').pop()), ['I140_rec_by_class_country_FY2022_Q3_Q4.csv', 'I140_rec_by_class_country_FY2021_Q3_Q4.csv']);
});

test('older CSV releases: quarter labels over one column, and a block per country merged into earlier filing years', async () => {
    const quarterly = await parseQuarterly(Buffer.from(['\uFEFF,,,,,,,,,,,,,,,,,,,,', 'Form I-140 Immigrant Petition for Alien Worker', 'Fiscal Year 2022 (Q1-Q4)',
        ',,          1st Quarter,,,,          2nd Quarter,,,,3rd Quarter,,,,4th Quarter,,,,Fiscal Year Total,,',
        ',Received1,Approved2,Denied3,Pending4,Received1,Approved2,Denied3,Pending4,Received1,Approved2,Denied3,Pending4,Received1,Approved2,Denied3,Pending4,Received1,Approved2,Denied3,Pending4',
        'TOTAL," 42,526 "," 38,527 "," 1,470 "," 101,567 ",1,2,3,4,5,6,7,8,9,10,11,12,99,99,99,99', 'Table Key:'].join('\n')), 'I140_FY22_Q4_RADP.csv');
    assert.deepEqual(parsed(quarterly), [[1, { received: 42526, approved: 38527, denied: 1470, pending: 101567 }], [2, { received: 1, approved: 2, denied: 3, pending: 4 }], [3, { received: 5, approved: 6, denied: 7, pending: 8 }], [4, { received: 9, approved: 10, denied: 11, pending: 12 }]]);

    const block = (country, years, eb3) => [`Number of Form I-140 Petitions Received and Current Status for ${country}`, `Fiscal Years ${years[0]} to ${years.at(-1)}`,
        `Petitions by Employment Preference,${years.join(',')},TOTAL`, `TOTAL,${years.map(() => 10).join(',')},99`, `Approved,${years.map(() => 8).join(',')},99`, `Denied,${years.map(() => 2).join(',')},99`,
        'Second Preference (EB2)', `Total Petitions,${years.map(() => 4).join(',')}`, `Approved,${years.map(() => 3).join(',')}`, `Denied,${years.map(() => 1).join(',')}`,
        'Approvals by Category', `Professionals with Advanced Degrees (E21)2,${years.map(() => 3).join(',')}`,
        'Third Preference (EB3)', `Approved,${years.map(() => eb3).join(',')}`, 'Other and Unknown,1,1,1', 'Approved,40,40,40', 'Reference(s):'];
    const older = await parseCohorts(Buffer.from([...block('the Philippines', [2011, 2012, 2013], 5), ...block('All Countries', [2011, 2012, 2013], 7)].join('\n')), 'old.csv');
    assert.deepEqual(older.countries.map(country => country.name), ['Philippines', 'All countries']);
    assert.deepEqual(older.countries[1].categories.eb3.approved, [7, 7, 7], '"Other and Unknown" rows are not counted as EB-3');
    const current = { countries: [{ name: 'All countries', years: [2014], categories: { all: { total: [20], approved: [15], denied: [5] }, eb2: { approved: [6] }, eb3: { approved: [9] } }, approvals: { eb2a: [5], niw: [1] } }] };
    mergeCohortHistory(current, [{ ...older, source: { name: 'I140_rec_by_class_country_FY2021_Q3_Q4.csv' } }]);
    const [all] = current.countries;
    assert.deepEqual(all.years, [2011, 2012, 2013, 2014]);
    assert.deepEqual(all.categories.eb3.approved, [7, 7, 7, 9]);
    assert.deepEqual(all.approvals.niw, [null, null, null, 1], 'older reports counted NIW within E21: unknown, not zero');
    assert.deepEqual(current.history, [{ year: 2011, sources: ['I140_rec_by_class_country_FY2021_Q3_Q4.csv'] }, { year: 2012, sources: ['I140_rec_by_class_country_FY2021_Q3_Q4.csv'] }, { year: 2013, sources: ['I140_rec_by_class_country_FY2021_Q3_Q4.csv'] }]);
});
const parsed = result => result.quarters.map(quarter => [quarter.quarter, quarter.categories.all]);
