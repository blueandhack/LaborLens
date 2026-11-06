const fs = require('fs');
const { Readable, Transform } = require('stream');
const { pipeline } = require('stream/promises');
const { createHash } = require('crypto');

const PERFORMANCE_URL = 'https://www.dol.gov/agencies/eta/foreign-labor/performance';
const USER_AGENT = 'LaborLens/1.0 (DOL public disclosure importer)';
const MAX_FILE_BYTES = 768 * 1024 * 1024;

function dolURL(value, base = PERFORMANCE_URL) {
    const url = new URL(value, base);
    if (url.protocol !== 'https:' || !/(^|\.)dol\.gov$/i.test(url.hostname)
        || url.username || url.password || (url.port && url.port !== '443')) {
        throw new Error('Only HTTPS downloads hosted by dol.gov are allowed');
    }
    return url.href;
}

function discoverDatasets(html, { fromYear } = {}) {
    const datasets = new Map();
    for (const match of html.matchAll(/\bhref\s*=\s*["']([^"']+)["']/gi)) {
        let url;
        try { url = dolURL(match[1].replace(/&amp;/gi, '&')); } catch { continue; }
        const filename = decodeURIComponent(new URL(url).pathname.split('/').pop());
        const name = filename.match(/^(PW|PWD|PERM)_(?:(?:Disclosure_Data(?:_New_Form)?|Case_Data)_)?FY(\d{4}|\d{2})(?:_Q([1-4]))?(?:_(?:EOY|old_form|revised_form|new_form))?\.xlsx$/i);
        if (!name) continue;
        const type = name[1].toUpperCase() === 'PERM' ? 'perm' : 'pwd';
        const year = Number(name[2]) + (name[2].length === 2 ? 2000 : 0);
        datasets.set(url, { url, filename, type, fiscalYear: year, quarter: Number(name[3] || 4) });
    }
    const selected = [];
    for (const type of ['pwd', 'perm']) {
        const files = [...datasets.values()].filter(file => file.type === type);
        if (!files.length) throw new Error(`DOL page contains no supported ${type.toUpperCase()} disclosure files`);
        const years = fromYear === undefined ? [Math.max(...files.map(file => file.fiscalYear))]
            : [...new Set(files.map(file => file.fiscalYear))].filter(year => year >= fromYear).sort((a, b) => b - a);
        // Quarterly files are cumulative. Keep all form variants in the latest
        // release, but exclude superseded quarters and worksite/appendix files.
        for (const year of years) {
            const quarter = Math.max(...files.filter(file => file.fiscalYear === year).map(file => file.quarter));
            selected.push(...files.filter(file => file.fiscalYear === year && file.quarter === quarter)
                .sort((a, b) => a.filename.localeCompare(b.filename)));
        }
    }
    return selected;
}

async function requestDOL(url, { headers = {}, signal } = {}) {
    let target = dolURL(url);
    for (let redirects = 0; redirects <= 5; redirects++) {
        const response = await fetch(target, {
            headers: { 'User-Agent': USER_AGENT, ...headers }, redirect: 'manual', signal,
        });
        if ([301, 302, 303, 307, 308].includes(response.status)) {
            const location = response.headers.get('location');
            await response.body?.cancel();
            if (!location) throw new Error('DOL redirect is missing its destination');
            target = dolURL(location, target);
            continue;
        }
        if (!response.ok && response.status !== 304) {
            await response.body?.cancel();
            throw new Error(`DOL request failed: HTTP ${response.status} (${target})`);
        }
        return response;
    }
    throw new Error('Too many DOL redirects');
}

async function fetchDatasets({ signal = AbortSignal.timeout(60000), fromYear } = {}) {
    const response = await requestDOL(PERFORMANCE_URL, { signal });
    let html = '';
    for await (const chunk of response.body) {
        html += Buffer.from(chunk).toString('utf8');
        if (html.length > 5 * 1024 * 1024) throw new Error('DOL page exceeds the size limit');
    }
    return discoverDatasets(html, { fromYear });
}

async function downloadDataset(dataset, destination, previous, { force = false, signal = AbortSignal.timeout(15 * 60 * 1000) } = {}) {
    const headers = {};
    if (!force && previous?.sha256) {
        if (previous.etag) headers['If-None-Match'] = previous.etag;
        else if (previous.lastModified) headers['If-Modified-Since'] = previous.lastModified;
    }
    const response = await requestDOL(dataset.url, { headers, signal });
    if (response.status === 304) {
        if (!previous?.sha256 || force) throw new Error('Unexpected DOL HTTP 304 without an imported file');
        return { unchanged: true };
    }
    if (Number(response.headers.get('content-length')) > MAX_FILE_BYTES) {
        await response.body?.cancel();
        throw new Error('DOL workbook exceeds the download size limit');
    }
    const hash = createHash('sha256');
    let bytes = 0;
    let signature = Buffer.alloc(0);
    const inspect = new Transform({
        transform(chunk, encoding, callback) {
            bytes += chunk.length;
            if (bytes > MAX_FILE_BYTES) return callback(new Error('DOL workbook exceeds the download size limit'));
            if (signature.length < 4) signature = Buffer.concat([signature, chunk.subarray(0, 4 - signature.length)]);
            hash.update(chunk);
            callback(null, chunk);
        },
    });
    await pipeline(Readable.fromWeb(response.body), inspect, fs.createWriteStream(destination, { flags: 'wx' }), { signal });
    if (!signature.equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]))) throw new Error('DOL response is not an XLSX/ZIP workbook');
    const sha256 = hash.digest('hex');
    return {
        unchanged: !force && previous?.sha256 === sha256,
        sha256, bytes, etag: response.headers.get('etag'), lastModified: response.headers.get('last-modified'),
    };
}

module.exports = { PERFORMANCE_URL, dolURL, discoverDatasets, requestDOL, fetchDatasets, downloadDataset };
