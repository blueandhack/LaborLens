import test from 'node:test';
import assert from 'node:assert/strict';
import { reportIssues, validationOutcome, sourceStatus, needsAttention, isProcessing } from '../src/utils/importPresentation.js';

test('validation distinguishes blocked files, tolerated issues, and missing outcomes', () => {
    assert.equal(validationOutcome({ canImport: false, rejectedRows: 1 }).tone, 'error');
    assert.equal(validationOutcome({ canImport: true, issues: { 'DECISION_DATE:invalid_date': 2 } }).tone, 'warning');
    assert.equal(validationOutcome({ canImport: true, issues: {} }).tone, 'success');
    assert.equal(validationOutcome({ rows: 40 }).tone, 'neutral');
    assert.equal(validationOutcome({ canImport: true, rejectedRows: 2 }).tone, 'error');
});

test('issue summaries preserve source fields and sort full-file counts', () => {
    assert.deepEqual(reportIssues({ issues: { 'WAGE:invalid_number': 3, 'DECISION_DATE:invalid_date': 7, 'OTHER:excel_error': 0 } }), [
        { code: 'DECISION_DATE:invalid_date', field: 'DECISION_DATE', reason: 'Invalid date', count: 7 },
        { code: 'WAGE:invalid_number', field: 'WAGE', reason: 'Invalid number', count: 3 },
    ]);
});

test('import results distinguish unchanged files and interrupted work', () => {
    assert.equal(sourceStatus({ status: 'done', outcome: 'unchanged' }), 'Up to date');
    assert.equal(sourceStatus({ status: 'done', outcome: 'imported' }), 'Imported');
    assert.equal(needsAttention({ status: 'interrupted' }), true);
    assert.equal(needsAttention({ status: 'validating' }), false);
    assert.equal(isProcessing({ status: 'validating' }), true);
    assert.equal(isProcessing({ status: 'done' }), false);
});
