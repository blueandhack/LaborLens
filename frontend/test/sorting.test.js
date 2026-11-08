import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaultCaseSort, caseSortOptions, readCaseSort } from '../src/utils/sorting.js';
import { certificationDate } from '../src/utils/casePresentation.js';
import { writeSearchState } from '../src/utils/searchState.js';
import { getPageSEO } from '../src/utils/seo.js';

test('sort defaults distinguish certification, determination and decision dates', () => {
  assert.equal(defaultCaseSort('h1b'), 'certification_desc');
  assert.equal(defaultCaseSort('pwd'), 'event_desc');
  assert.equal(readCaseSort(new URLSearchParams('sort=certification_desc'), 'perm'), 'event_desc');
  assert.equal(caseSortOptions('h1b').length, 6);
  assert.equal(writeSearchState({ employer: ' example inc ' }, 2, 48, 'cards', 'certification_asc').get('sort'), 'certification_asc');
});
test('a later withdrawal cannot replace an original certification; missing dates stay missing', () => {
  assert.equal(certificationDate({ CASE_STATUS: 'Certified-Withdrawn', ORIGINAL_CERT_DATE: '2014-01-01', DECISION_DATE: '2026-01-01' }), '2014-01-01');
  assert.equal(certificationDate({ CASE_STATUS: 'CERTIFIED', DECISION_DATE: '2025-01-01' }), '2025-01-01');
  assert.equal(certificationDate({ CASE_STATUS: 'Certified-Withdrawn', DECISION_DATE: '2026-01-01' }), null);
  assert.equal(certificationDate({ CASE_STATUS: 'Denied', DECISION_DATE: '2026-01-01' }), null);
  assert.equal(certificationDate({ CASE_STATUS: 'Certified', DECISION_DATE: 'bad date' }), null);
});
test('sorted and paginated URLs do not create duplicate indexable landing pages', () => {
  for (const [path, search] of [['/h1b', '?sort=certification_asc'], ['/employers', '?sort=name_asc'], ['/employers', '?q=Google'], ['/employers', '?page=2']]) assert.equal(getPageSEO(path, search).robots, 'noindex, follow');
});
