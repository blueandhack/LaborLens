const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseUscisFile, industryOf, expanded } = require('../services/uscisH1b');

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
    // Initial: new employment, new concurrent, change of employer. Continuing: the rest.
    assert.deepEqual([row.initialApprovals, row.initialDenials, row.continuingApprovals, row.continuingDenials], [10 + 4 + 5, 1 + 1 + 1, 20 + 3 + 6, 2 + 0 + 0]);
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
