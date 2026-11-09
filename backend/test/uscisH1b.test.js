const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Readable } = require('node:stream');
const { parseUscisFile, parseUscisStream, industryOf, expanded } = require('../services/uscisH1b');

test('archived Data Hub files (initial and continuing totals) parse', () => {
    const csv = '﻿"Fiscal Year",Employer,"Initial Approval","Initial Denial","Continuing Approval","Continuing Denial",NAICS,"Tax ID",State,City,ZIP\r\n'
        + '2023,"ACME, INC.","1,326",2,30,0,54,0209,wa,Seattle,98101\r\n'
        + '2023,,0,1,0,0,,8070,DE,WILMINGTON,1801\r\n';
    const { rows, format } = parseUscisFile(Buffer.from(csv));
    assert.equal(format, 'initial-continuing');
    assert.deepEqual(rows[0], { fiscalYear: 2023, employer: 'ACME, INC.', nameKey: 'acme inc', groupKey: 'acme inc', searchKey: 'acme inc', naics: '54', industry: '54',
        taxId: '0209', state: 'WA', city: 'SEATTLE', zip: '98101', initialApprovals: 1326, initialDenials: 2, continuingApprovals: 30, continuingDenials: 0 });
    assert.equal(rows[1].nameKey, null, 'a blank petitioner name stays blank');
    assert.equal(rows[1].naics, '99', 'a blank industry is unknown (99), as USCIS assigns it');
    assert.equal(rows[1].zip, '01801');
});

test('hub crosstab exports (UTF-16, tab-separated, six petition types) combine into initial and continuing totals', () => {
    const types = ['New Employment', 'Continuation', 'Change with Same Employer', 'New Concurrent', 'Change of Employer', 'Amended'];
    const head = ['Line by line', 'Fiscal Year', 'Employer (Petitioner) Name', 'Tax ID', 'Industry (NAICS) Code', 'Petitioner City', 'Petitioner State', 'Petitioner Zip Code',
        ...types.flatMap(type => [type + ' Approval', type + ' Denial'])];
    const line = ['1', '2025', 'Globex Tech Solns LLC', '1234', '54 - Professional, Scientific, and Technical Services', 'Austin', 'TX', '78701',
        '10', '1', '20', '2', '3', '0', '4', '1', '5', '1', '6', '0'];
    const text = '﻿' + [head, line, ['', 'Grand Total', '', '', '', '', '', '', ...Array(12).fill('99')]].map(row => row.join('\t')).join('\r\n');
    const { rows, format } = parseUscisFile(Buffer.from(text, 'utf16le'));
    assert.equal(format, 'petition-types');
    assert.equal(rows.length, 1, 'the total line is skipped');
    const [row] = rows;
    // Initial: new employment and new concurrent. Continuing: the rest, including change of employer.
    assert.deepEqual([row.initialApprovals, row.initialDenials, row.continuingApprovals, row.continuingDenials], [10 + 4, 1 + 1, 20 + 3 + 5 + 6, 2 + 0 + 1 + 0]);
    assert.deepEqual(row.categories.changeOfEmployer, { approvals: 5, denials: 1 });
    assert.equal(row.naics, '54');
    assert.equal(row.groupKey, 'globex technology solutions llc');
});

test('files that are not Data Hub exports are rejected with the reason', () => {
    assert.throws(() => parseUscisFile(Buffer.from('CASE_NUMBER,EMPLOYER_NAME\nI-1,ACME\n')), /missing fiscal year, initial\/continuing/);
    assert.throws(() => parseUscisFile(Buffer.from('Fiscal Year,Employer,Initial Approval,Initial Denial,Continuing Approval,Continuing Denial\n2020,ACME,x,0,0,0\n')), /Line 2: Invalid count "x"/);
});

test('industries group two-digit NAICS sectors; abbreviations expand', () => {
    assert.equal(industryOf('32'), '31-33');
    assert.equal(industryOf('45'), '44-45');
    assert.equal(industryOf('00'), '99');
    assert.equal(expanded('cisco syss inc'), 'cisco systems inc');
    assert.equal(expanded('univ of washington'), 'university of washington');
});

test('the hub\'s long CSV (one line per petition type) becomes one row per petitioner, from a file or a stream', async () => {
    const types = ['New Employment', 'Continuation', 'Change with Same Employer', 'New Concurrent', 'Change of Employer', 'Amended'];
    const lines = ['\uFEFFEmployer (Petitioner) Name,Fiscal Year   ,Industry (NAICS) Code,Measure Names,Petitioner City,Petitioner State,Petitioner Zip Code,Tax ID,Line by line,Measure Values'];
    types.forEach((type, i) => {
        lines.push(`"ACME, INC.",2025,31-33 - Manufacturing,${type} Approval,AUSTIN,TX,78701,0209,1,"${i === 0 ? '1,200' : i}"`);
        lines.push(`"ACME, INC.",2025,31-33 - Manufacturing,${type} Denial,AUSTIN,TX,78701,0209,1,${i === 4 ? 3 : 0}`);
        lines.push(`,2025,,${type} Approval,,,,,2,0`, `,2025,,${type} Denial,,,,,2,0`); // A row without decisions.
    });
    const csv = lines.join('\r\n') + '\r\n';
    for (const parsed of [parseUscisFile(Buffer.from(csv)), await parseUscisStream(Readable.from([csv.slice(0, 500), csv.slice(500)]))]) {
        assert.equal(parsed.format, 'petition-types');
        assert.equal(parsed.rows.length, 1, 'rows without decisions are dropped');
        const [row] = parsed.rows;
        assert.equal(row.employer, 'ACME, INC.');
        assert.equal(row.industry, '31-33');
        assert.deepEqual(row.categories.newEmployment, { approvals: 1200, denials: 0 });
        assert.deepEqual([row.initialApprovals, row.initialDenials, row.continuingApprovals, row.continuingDenials], [1200 + 3, 0, 1 + 2 + 4 + 5, 3]);
    }
    assert.throws(() => parseUscisFile(Buffer.from(lines[0] + '\nACME,2025,54,Mystery Approval,A,TX,1,1,1,1\n')), /Line 2: Unknown measure "Mystery Approval"/);
});
