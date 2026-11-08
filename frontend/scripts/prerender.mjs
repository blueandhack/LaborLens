import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { render } from '../dist-ssr/entry-server.js';
import { getPageSEO, SITE_ORIGIN } from '../src/utils/seo.js';

const dist = new URL('../dist/', import.meta.url);
const template = await readFile(new URL('index.html', dist), 'utf8');
await writeFile(new URL('profile-shell.html', dist), template);
const escape = value => String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const head = metadata => [
  `<title>${escape(metadata.title)}</title>`,
  `<meta name="description" content="${escape(metadata.description)}">`,
  `<meta name="robots" content="${metadata.robots}">`,
  ...(metadata.canonical ? [`<link rel="canonical" href="${escape(metadata.canonical)}">`, `<meta property="og:url" content="${escape(metadata.canonical)}">`] : []),
  '<meta property="og:type" content="website">',
  `<meta property="og:title" content="${escape(metadata.title)}">`,
  `<meta property="og:description" content="${escape(metadata.description)}">`,
  `<meta property="og:image" content="${SITE_ORIGIN}/icon.png">`,
  '<meta name="twitter:card" content="summary">',
  `<meta name="twitter:title" content="${escape(metadata.title)}">`,
  `<meta name="twitter:description" content="${escape(metadata.description)}">`,
  ...(metadata.structuredData ? [`<script id="seo-structured-data" type="application/ld+json">${JSON.stringify(metadata.structuredData).replace(/</g, '\\u003c')}</script>`] : []),
].join('\n');

function page(path, metadata = getPageSEO(path), body = render(path)) {
  const html = template.replace(/<!--seo:start-->[\s\S]*?<!--seo:end-->/, head(metadata))
    .replace('<div id="root"></div>', () => `<div id="root">${body}</div>`);
  if (!html.includes(`<title>${escape(metadata.title)}</title>`) || /<!--seo:/.test(html)) throw new Error('SEO template replacement failed');
  return html.replace('<body>', '<body><noscript><p class="noscript-notice">Interactive case search requires JavaScript. You can read our <a href="/data">data sources and methodology</a> or visit the <a href="https://www.dol.gov/agencies/eta/foreign-labor/performance">original DOL disclosure files</a>.</p></noscript>');
}

await mkdir(new URL('seo/', dist), { recursive: true });
for (const [path, file] of [['/', 'pwd'], ['/h1b', 'h1b'], ['/perm', 'perm'], ['/data', 'data'], ['/employers', 'employers']]) {
  const html = page(path);
  await writeFile(new URL(`seo/${file}.html`, dist), html);
  if (path === '/') await writeFile(new URL('index.html', dist), html);
  if (path === '/data' || path === '/employers') continue;
  await writeFile(new URL(`seo/${file}-filtered.html`, dist), page(path, getPageSEO(path, '?company=filtered')));
}
await writeFile(new URL('seo/admin.html', dist), page('/admin/data', getPageSEO('/admin/data'), ''));
await writeFile(new URL('app.html', dist), page('/cases/' + '0'.repeat(24), getPageSEO('/cases/' + '0'.repeat(24)), ''));
await writeFile(new URL('404.html', dist), page('/not-found'));
console.log('Pre-rendered five public pages, filtered search shells, employer SSR template, admin metadata, case shell, and 404 page.');
