import { programs } from './programs.js';
import { presentCase } from './casePresentation.js';

export const SITE_ORIGIN = 'https://laborlens.fyi';
export const PUBLIC_PATHS = ['/', '/h1b', '/perm', '/employers', '/data', '/privacy/', '/terms/'];
export const SEARCH_RESULT_KEYS = ['company', 'employer', 'jobTitle', 'location', 'worksite', 'caseNumber', 'determinationYear', 'decisionYear', 'receivedYear', 'page'];
const searchPrograms = { '/': 'pwd', '/perm': 'perm', '/h1b': 'h1b' };
const descriptions = {
  pwd: 'Search public DOL prevailing wage determinations by employer, job title, location, and case number. View reported wage rates and original disclosure sources.',
  perm: 'Search the PERM database for employer labor certification records, offered wages, case decisions, and original U.S. Department of Labor disclosures.',
  h1b: 'Search the H1B salary database and DOL LCA records by employer, job title, location, and case number. Compare reported wage ranges in their original pay periods.',
};

export function getPageSEO(pathname, search = '') {
  const path = pathname === '/' ? '/' : pathname.replace(/\/+$/, '');
  const program = searchPrograms[path];
  const params = new URLSearchParams(search);
  const filtered = Boolean(program && SEARCH_RESULT_KEYS.some(key => params.get(key)));
  const title = program ? `${program === 'h1b' ? 'H1B Salary Database & LCA Search' : program === 'perm' ? 'PERM Database & Employer Case Search' : 'Prevailing Wage Determination Search'} | LaborLens`
    : path === '/employers' ? 'Employer H1B, PERM & Wage Profiles | LaborLens' : path === '/data' ? 'DOL Data Sources & Methodology | LaborLens'
      : ['/admin/data', '/import'].includes(path) ? 'Administration | LaborLens'
        : /^\/cases\/[a-f\d]{24}$/i.test(path) ? 'Case Disclosure | LaborLens' : 'Page Not Found | LaborLens';
  const description = program ? descriptions[program] : path === '/data'
    ? 'Understand LaborLens H-1B, PERM, and prevailing wage data: DOL sources, historical coverage, reported wage periods, case dates, and validation.'
    : 'Research public U.S. Department of Labor H-1B LCA, PERM labor certification, and prevailing wage disclosure records with LaborLens.';
  const indexable = Boolean((program || path === '/data' || path === '/employers') && !filtered);
  const casePage = /^\/cases\/[a-f\d]{24}$/i.test(path);
  return {
    title, description, canonical: indexable ? SITE_ORIGIN + path : null,
    robots: indexable || casePage ? 'index, follow' : 'noindex, follow',
    structuredData: indexable ? {
      '@context': 'https://schema.org', '@graph': [
        { '@type': 'WebSite', '@id': `${SITE_ORIGIN}/#website`, url: SITE_ORIGIN + '/', name: 'LaborLens' },
        { '@type': 'WebPage', '@id': SITE_ORIGIN + path, url: SITE_ORIGIN + path, name: title, description, inLanguage: 'en', isPartOf: { '@id': `${SITE_ORIGIN}/#website` } },
      ],
    } : null,
  };
}

export function getEmployerSEO(profile) {
  const title = `${profile.name} · H1B Salary & PERM Filing History | LaborLens`;
  const description = `Research ${profile.name} in public DOL H-1B, PERM, and prevailing wage disclosures. View filing history, reported wage ranges by pay period, job titles, and original sources.`;
  const canonical = SITE_ORIGIN + '/employers/' + profile.slug;
  return { title, description, canonical, robots: profile.ready ? 'index, follow' : 'noindex, follow', structuredData: profile.ready ? {
    '@context': 'https://schema.org', '@type': 'WebPage', url: canonical, name: title, description,
    dateModified: profile.snapshotAt, isPartOf: { '@type': 'WebSite', name: 'LaborLens', url: SITE_ORIGIN },
  } : null };
}

export function getCaseSEO(record, program) {
  const data = presentCase(record, program);
  return {
    title: `${record.CASE_NUMBER} · ${data.employer} · ${programs[program].label} | LaborLens`,
    description: `${programs[program].label} disclosure ${record.CASE_NUMBER}: ${data.employer}, ${data.title}. ${programs[program].wageLabel}: ${data.wage === 'N/A' ? 'not reported' : data.wage}. View the case and DOL source details.`,
    canonical: SITE_ORIGIN + '/cases/' + String(record._id).toLowerCase(),
    robots: 'index, follow', structuredData: null,
  };
}

export function applyPageSEO(metadata) {
  document.title = metadata.title;
  const meta = (attribute, key, value) => {
    let element = document.head.querySelector(`meta[${attribute}="${key}"]`);
    if (!element) { element = document.createElement('meta'); element.setAttribute(attribute, key); document.head.append(element); }
    element.content = value;
  };
  meta('name', 'description', metadata.description);
  meta('name', 'robots', metadata.robots);
  for (const [key, value] of Object.entries({ 'og:type': 'website', 'og:title': metadata.title, 'og:description': metadata.description, 'og:image': SITE_ORIGIN + '/icon.png', 'twitter:card': 'summary', 'twitter:title': metadata.title, 'twitter:description': metadata.description })) meta(key.startsWith('og:') ? 'property' : 'name', key, value);
  let canonical = document.head.querySelector('link[rel="canonical"]');
  if (metadata.canonical) {
    if (!canonical) { canonical = document.createElement('link'); canonical.rel = 'canonical'; document.head.append(canonical); }
    canonical.href = metadata.canonical;
    meta('property', 'og:url', metadata.canonical);
  } else {
    canonical?.remove();
    document.head.querySelector('meta[property="og:url"]')?.remove();
  }
  let structured = document.getElementById('seo-structured-data');
  if (metadata.structuredData) {
    if (!structured) { structured = document.createElement('script'); structured.id = 'seo-structured-data'; structured.type = 'application/ld+json'; document.head.append(structured); }
    structured.textContent = JSON.stringify(metadata.structuredData);
  } else structured?.remove();
}
