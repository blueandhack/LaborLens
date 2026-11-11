import test from 'node:test';
import assert from 'node:assert/strict';
import { NAV_GROUPS, NAV_ITEMS, activeNavItem, currentPageLabel } from '../src/utils/navigation.js';
import { PUBLIC_PATHS } from '../src/utils/seo.js';

test('every public page in the navigation is listed once, in its group', () => {
  assert.deepEqual(NAV_GROUPS.map(group => group.id), ['dol', 'uscis', 'explore']);
  const paths = NAV_ITEMS.map(item => item.to);
  assert.equal(new Set(paths).size, paths.length);
  for (const path of paths) assert.ok(PUBLIC_PATHS.includes(path), path);
  for (const item of NAV_ITEMS) assert.ok(item.label && item.description, item.to);
});

test('the active tab follows the address, including employer profiles', () => {
  assert.equal(activeNavItem('/').label, 'PWD');
  assert.equal(activeNavItem('/perm/').label, 'PERM');
  assert.equal(activeNavItem('/h1b').label, 'H-1B LCA');
  assert.equal(activeNavItem('/h1b-approvals').label, 'H-1B approvals');
  assert.equal(activeNavItem('/employers').label, 'Employers');
  assert.equal(activeNavItem('/employers/google-llc').label, 'Employers');
  assert.equal(activeNavItem('/employersx'), null);
  assert.equal(activeNavItem('/cases/abc'), null);
});

test('the small-screen menu button names the current page', () => {
  assert.equal(currentPageLabel('/i140'), 'I-140');
  assert.equal(currentPageLabel('/data'), 'Data sources');
  assert.equal(currentPageLabel('/admin/data'), 'Administration');
  assert.equal(currentPageLabel('/cases/0123'), 'Case');
  assert.equal(currentPageLabel('/nowhere'), 'Menu');
});

test('administration sections are linkable URLs that fall back to the overview', async () => {
  const { ADMIN_SECTIONS, adminSection, adminSectionPath } = await import('../src/utils/navigation.js');
  assert.equal(adminSectionPath('overview'), '/admin/data');
  for (const section of ADMIN_SECTIONS) {
    assert.equal(adminSection(new URL(adminSectionPath(section), 'https://laborlens.fyi').search), section);
  }
  assert.equal(adminSection(''), 'overview');
  assert.equal(adminSection('?section=unknown'), 'overview');
});
