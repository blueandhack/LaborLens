const express = require('express');
const { readFile } = require('node:fs/promises');
const { pathToFileURL } = require('node:url');
const path = require('node:path');
const { getProfile, suggestions, publicEmployer } = require('../services/employers');
let renderer;
async function renderDocument(url, profile, employers) {
    renderer ||= import(pathToFileURL(path.resolve(__dirname, '../../frontend/dist-ssr/entry-server.js')).href);
    const [module, template] = await Promise.all([renderer, readFile(path.resolve(__dirname, '../../frontend/dist/profile-shell.html'), 'utf8')]);
    return module.renderEmployerDocument(url, profile, template, employers);
}
function createEmployerRoutes({ db, models, render = renderDocument }) {
    const api = express.Router(), pages = express.Router();
    const preparing = async slug => slug.length <= 110 && /^[a-z0-9-]+--[a-f0-9]{24}$/.test(slug)
        && !(await db().collection('discovery_state').findOne({ _id: 'employers' }, { projection: { ready: 1 }, maxTimeMS: 1000 }))?.ready;
    api.get('/status', async (_req, res, next) => {
        try {
            const [directory, worksites] = await Promise.all([db().collection('discovery_state').findOne({ _id: 'employers' }), db().collection('discovery_state').findOne({ _id: 'worksites' })]);
            res.set('Cache-Control', 'public, max-age=30').json({ ready: Boolean(directory?.ready), building: Boolean(directory?.building), updatedAt: directory?.updatedAt || null, worksites: worksites?.programs || {} });
        } catch (error) { next(error); }
    });
    api.get('/', async (req, res, next) => {
        try {
            const employers = req.query.q !== undefined ? await suggestions(db(), req.query.q)
                : (await db().collection('employers').find({ featured: true }, { maxTimeMS: 1000 }).sort({ featuredRank: 1 }).limit(20).toArray()).map(publicEmployer);
            res.set('Cache-Control', 'public, max-age=30').json({ employers });
        } catch (error) { next(error); }
    });
    api.get('/:slug', async (req, res, next) => {
        try {
            const profile = await getProfile(db(), models, req.params.slug);
            if (!profile) {
                if (await preparing(req.params.slug)) return res.status(503).set('Cache-Control', 'no-store').set('Retry-After', '30').json({ error: 'Employer directory is being prepared. Please try again shortly.' });
                return res.status(404).set('Cache-Control', 'no-store').json({ error: 'Employer profile not found.' });
            }
            res.set('Cache-Control', profile.ready ? 'public, max-age=60' : 'no-store').json(profile);
        } catch (error) { next(error); }
    });
    pages.get('/', async (req, res, next) => {
        if (req.originalUrl.split('?')[0].endsWith('/')) return res.redirect(301, '/employers');
        try {
            const employers = (await db().collection('employers').find({ featured: true }).sort({ featuredRank: 1 }).limit(20).toArray()).map(publicEmployer);
            res.type('html').set('Cache-Control', 'public, max-age=60').send(await render('/employers', null, employers));
        } catch (error) { next(error); }
    });
    pages.get('/sitemap.xml', async (_req, res, next) => {
        try {
            const rows = await db().collection('employers').find({ featured: true }).sort({ featuredRank: 1 }).limit(100).toArray();
            const documents = await db().collection('employer_profiles').find({ _id: { $in: rows.map(row => row._id) } }, { projection: { updatedAt: 1 } }).toArray();
            const updated = new Map(documents.map(row => [row._id, row.updatedAt]));
            const xml = '<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">' + rows.filter(row => updated.has(row._id)).map(row => `<url><loc>https://laborlens.fyi/employers/${row.slug}</loc><lastmod>${updated.get(row._id).toISOString()}</lastmod></url>`).join('') + '</urlset>';
            res.type('application/xml').set('Cache-Control', 'public, max-age=300').send(xml);
        } catch (error) { next(error); }
    });
    pages.get('/:slug', async (req, res, next) => {
        try {
            const profile = await getProfile(db(), models, req.params.slug);
            if (!profile && await preparing(req.params.slug)) return res.status(503).set('Cache-Control', 'no-store').set('Retry-After', '30')
                .set('X-Robots-Tag', 'noindex, follow').type('html').send(await render('/employers', null, []));
            if (profile && profile.slug !== req.params.slug) return res.redirect(301, '/employers/' + profile.slug);
            res.status(profile ? 200 : 404).set('Cache-Control', profile?.ready ? 'public, max-age=60' : 'no-store')
                .set('X-Robots-Tag', profile?.ready ? 'index, follow' : 'noindex, follow').type('html')
                .send(await render(profile ? '/employers/' + profile.slug : '/not-found', profile));
        } catch (error) { next(error); }
    });
    function failure(error, _req, res, _next) {
        console.error('Employer discovery failed:', error.message);
        res.status(error.status || 503).set('Cache-Control', 'no-store').json({ error: error.status === 400 ? error.message : 'Employer information is temporarily unavailable. You can still search cases.' });
    }
    api.use(failure); pages.use(failure);
    return { api, pages };
}
module.exports = { createEmployerRoutes };
