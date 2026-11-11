// Site navigation, grouped by who publishes the data. The same list drives the
// desktop tabs and the small-screen menu.
export const NAV_GROUPS = [
  {
    id: 'dol', label: 'Department of Labor', short: 'DOL filings',
    items: [
      { to: '/', label: 'PWD', description: 'Prevailing wage determinations' },
      { to: '/perm', label: 'PERM', description: 'Green card labor certifications' },
      { to: '/h1b', label: 'H-1B LCA', description: 'Labor condition applications and offered wages' },
    ],
  },
  {
    id: 'uscis', label: 'USCIS', short: 'USCIS decisions',
    items: [
      { to: '/h1b-approvals', label: 'H-1B approvals', description: 'Approval and denial rates by employer' },
      { to: '/i140', label: 'I-140', description: 'Green card petitions and the visa backlog' },
    ],
  },
  {
    id: 'explore', label: 'Explore', short: 'Explore',
    items: [
      { to: '/employers', label: 'Employers', description: 'One profile across every program', prefix: true },
      { to: '/map', label: 'Map', description: 'Filings by state, county and city' },
    ],
  },
];

export const NAV_ITEMS = NAV_GROUPS.flatMap(group => group.items.map(item => ({ ...item, group: group.id })));

// Secondary destinations, shown in the small-screen menu (they are also in the footer).
export const MENU_LINKS = [
  { to: '/data', label: 'Data sources' },
  { to: '/admin/data', label: 'Administration' },
];

// Administration sections live in the URL so each can be linked, bookmarked,
// opened in a new tab, and reached with the back button.
export const ADMIN_SECTIONS = ['overview', 'automatic', 'data', 'manual', 'security'];
export const adminSection = search => {
  const section = new URLSearchParams(search).get('section');
  return ADMIN_SECTIONS.includes(section) ? section : 'overview';
};
export const adminSectionPath = section => section === 'overview' ? '/admin/data' : `/admin/data?section=${section}`;

const normalize = pathname => (pathname || '/').replace(/\/+$/, '') || '/';

export function activeNavItem(pathname) {
  const path = normalize(pathname);
  return NAV_ITEMS.find(item => item.prefix ? path === item.to || path.startsWith(item.to + '/') : path === item.to) || null;
}

// The label on the small-screen menu button, so readers always see where they are.
export function currentPageLabel(pathname) {
  const item = activeNavItem(pathname);
  if (item) return item.label;
  const path = normalize(pathname);
  if (path === '/data') return 'Data sources';
  if (path === '/admin/data' || path === '/import') return 'Administration';
  if (/^\/cases\//.test(path)) return 'Case';
  return 'Menu';
}
