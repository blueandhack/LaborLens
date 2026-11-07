import { test } from 'node:test';
import assert from 'node:assert/strict';
import { presentCase } from '../src/utils/casePresentation.js';
import { elapsedDays } from '../src/utils/casePresentation.js';
import { programs } from '../src/utils/programs.js';
import { readSearchState, writeSearchState } from '../src/utils/searchState.js';

test('H-1B summaries use offered wages and decision dates without annualizing hourly amounts', () => {
  const item = { EMPLOYER_NAME: 'Example LLC', EMPLOYER_CITY: 'Austin', EMPLOYER_STATE: 'TX',
    WAGE_RATE_OF_PAY_FROM: 60, WAGE_RATE_OF_PAY_TO: 70, WAGE_UNIT_OF_PAY: 'Hour', PREVAILING_WAGE: 100000,
    RECEIVED_DATE: '2025-12-31T00:00:00.000Z', DECISION_DATE: '2026-01-07T00:00:00.000Z',
    CASE_STATUS: 'Certified-Withdrawn' };
  const result = presentCase(item, 'h1b');
  assert.equal(result.employer, 'Example LLC'); assert.equal(result.location, 'Austin, TX');
  assert.match(result.wage, /60/); assert.match(result.wage, /70/); assert.match(result.wage, /Hour/);
  assert.doesNotMatch(result.wage, /100,000|Year/);
  assert.equal(result.eventDate, item.DECISION_DATE); assert.equal(result.elapsed, null);
  assert.equal(result.status, 'Certified-Withdrawn');
  assert.equal(presentCase({ ...item, WAGE_UNIT_OF_PAY: null }, 'h1b').wage.includes('Year'), false);
});

test('later LCA actions never appear as certification processing time or replace an original certification date', () => {
  const source = { CASE_STATUS: 'Certified - Withdrawn', RECEIVED_DATE: '2022-04-26T00:00:00.000Z',
    ORIGINAL_CERT_DATE: '2022-05-03T00:00:00.000Z', DECISION_DATE: '2026-06-30T00:00:00.000Z' };
  const result = presentCase(source, 'h1b');
  assert.equal(elapsedDays(source.RECEIVED_DATE, source.ORIGINAL_CERT_DATE), 7);
  assert.equal(elapsedDays(source.RECEIVED_DATE, source.DECISION_DATE), 1526);
  assert.equal(result.elapsed, null);
  assert.equal(result.eventDate, source.DECISION_DATE);
  assert.equal(result.originalCertificationDate, source.ORIGINAL_CERT_DATE);
  assert.equal(programs.h1b.dateLabel, 'Last action date');
  assert.equal(programs.h1b.yearLabel, 'Last action year');
  assert.equal(presentCase({ ...source, ORIGINAL_CERT_DATE: null }, 'h1b').originalCertificationDate, null);
  assert.equal(presentCase(source, 'perm').elapsed, 1526);
  assert.equal(presentCase({ ...source, DETERMINATION_DATE: source.DECISION_DATE }, 'pwd').elapsed, 1526);
});

test('H-1B search navigation preserves decision year, employer and pagination', () => {
  const params = new URLSearchParams('company=Example&decisionYear=2026&determinationYear=2024&page=2&limit=48&view=cards');
  const state = readSearchState(params, 'h1b');
  assert.equal(state.filters.decisionYear, '2026'); assert.equal(state.filters.determinationYear, undefined);
  const saved = writeSearchState(state.filters, state.page, state.limit, 'cards');
  assert.equal(saved.get('company'), 'Example'); assert.equal(saved.get('decisionYear'), '2026');
  assert.equal(saved.get('page'), '2'); assert.equal(saved.get('limit'), '48'); assert.equal(saved.get('view'), 'cards');
});
