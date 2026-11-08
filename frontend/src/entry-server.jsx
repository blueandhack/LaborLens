import { renderToString } from 'react-dom/server';
import { StaticRouter } from 'react-router-dom';
import App from './App.jsx';
import { getEmployerSEO, getPageSEO } from './utils/seo.js';

// Build-time rendering uses the real public UI. Data queries still run on the
// client, so the release does not freeze case counts or require database access.
export function render(path, initial = {}) {
  return renderToString(<App RouterComponent={StaticRouter} routerProps={{ location: path }} initialEmployer={initial.employer} initialEmployers={initial.employers} />);
}

export function renderEmployerDocument(path, profile, template, employers) {
  const location = new URL(path, 'https://laborlens.fyi');
  const metadata = profile ? getEmployerSEO(profile) : getPageSEO(location.pathname, location.search);
  const escape = value => String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
  const json = value => JSON.stringify(value).replace(/</g, '\\u003c');
  const initial = { employer: profile || null, ...(employers ? { employers } : {}) };
  const head = `<title>${escape(metadata.title)}</title><meta name="description" content="${escape(metadata.description)}"><meta name="robots" content="${metadata.robots}">`
    + (metadata.canonical ? `<link rel="canonical" href="${escape(metadata.canonical)}"><meta property="og:url" content="${escape(metadata.canonical)}">` : '')
    + `<meta property="og:type" content="website"><meta property="og:title" content="${escape(metadata.title)}"><meta property="og:description" content="${escape(metadata.description)}"><meta property="og:image" content="https://laborlens.fyi/icon.png">`
    + (metadata.structuredData ? `<script id="seo-structured-data" type="application/ld+json">${json(metadata.structuredData)}</script>` : '');
  return template.replace(/<!--seo:start-->[\s\S]*?<!--seo:end-->/, () => head)
    .replace('<div id="root"></div>', () => `<div id="root">${render(path, initial)}</div><script id="employer-bootstrap" type="application/json">${json(initial)}</script>`);
}
