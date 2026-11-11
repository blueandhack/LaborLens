import test from 'node:test';
import assert from 'node:assert/strict';
import { getCaseSEO, getPageSEO, PUBLIC_PATHS, SITE_ORIGIN } from '../src/utils/seo.js';

test('program landing pages have distinct canonical URLs and program-specific metadata', () => {
  const pages = ['/', '/h1b', '/perm'].map(path => getPageSEO(path));
  assert.equal(new Set(pages.map(page => page.canonical)).size, 3);
  assert.match(pages[0].title, /Prevailing Wage/);
  assert.match(pages[1].title, /H1B Salary Database/);
  assert.match(pages[2].description, /PERM/);
  for (const page of pages) {
    assert.equal(page.robots, 'index, follow');
    assert.equal(page.structuredData['@graph'][1].url, page.canonical);
  }
});

test('search results are excluded from indexing while layout and tracking variants consolidate to the program', () => {
  for (const path of ['/', '/h1b', '/perm']) {
    for (const query of ['?company=Google', '?caseNumber=I-200', '?page=2&limit=48', '?decisionYear=2026']) {
      const page = getPageSEO(path, query);
      assert.equal(page.robots, 'noindex, follow');
      assert.equal(page.canonical, null);
      assert.equal(page.structuredData, null);
    }
    assert.equal(getPageSEO(path, '?view=cards&utm_source=reference').canonical, SITE_ORIGIN + path);
    assert.equal(getPageSEO(path, '?view=table').robots, 'index, follow');
  }
});

test('private and unknown pages are noindex and do not claim a homepage canonical', () => {
  for (const path of ['/admin/data', '/import', '/backups/', '/missing-page', '/cases/not-an-id']) {
    const page = getPageSEO(path);
    assert.equal(page.robots, 'noindex, follow');
    assert.equal(page.canonical, null);
  }
  assert(!PUBLIC_PATHS.some(path => /admin|backups|cases|import/.test(path)));
});

test('case metadata describes an hourly LCA as reported and uses a stable case canonical', () => {
  const page = getCaseSEO({ _id: 'ABCDEF1234567890ABCDEF12', CASE_NUMBER: 'I-200-26001-100000', EMPLOYER_NAME: 'Research & Systems', JOB_TITLE: 'Engineer', WAGE_RATE_OF_PAY_FROM: 78.25, WAGE_UNIT_OF_PAY: 'Hour' }, 'h1b');
  assert.equal(page.canonical, SITE_ORIGIN + '/cases/abcdef1234567890abcdef12');
  assert.match(page.description, /78.25.*Hour/);
  assert.match(page.title, /Research & Systems/);
  assert.equal(page.robots, 'index, follow');
  assert.equal(getPageSEO('/cases/abcdef1234567890abcdef12').canonical, null);
});

test('the homepage leads with the brand and describes the site and its publisher for name searches', () => {
  const home = getPageSEO('/');
  assert.match(home.title, /^LaborLens:/);
  assert.match(home.description, /^LaborLens /);
  const [website, , organization] = home.structuredData['@graph'];
  assert.equal(website.name, 'LaborLens');
  assert(website.alternateName.includes('Labor Lens'));
  assert.equal(organization['@type'], 'Organization');
  assert.equal(website.publisher['@id'], organization['@id']);
  assert.match(getPageSEO('/h1b').title, /\| LaborLens$/);
  assert.doesNotMatch(getPageSEO('/', '?company=Google').title, /^LaborLens:/);
});
