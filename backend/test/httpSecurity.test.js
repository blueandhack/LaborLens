const { test } = require('node:test');
const assert = require('node:assert/strict');
const { configuredOrigins, corsOptions, securityHeaders, CSP } = require('../services/httpSecurity');

test('CORS accepts only exact configured origins and non-browser requests', async () => {
    assert.deepEqual([...configuredOrigins('https://laborlens.fyi,http://localhost:3000,not a url')],
        ['https://laborlens.fyi', 'http://localhost:3000']);
    const check = origin => new Promise((resolve, reject) => corsOptions('https://laborlens.fyi').origin(origin, (error, allowed) => error ? reject(error) : resolve(allowed)));
    assert.equal(await check(undefined), true);
    assert.equal(await check('https://laborlens.fyi'), true);
    assert.equal(await check('https://laborlens.fyi.evil.example'), false);
    assert.equal(await check('null'), false);
});

test('security middleware applies browser isolation headers', () => {
    let headers;
    securityHeaders({}, { set(value) { headers = value; } }, () => {});
    assert.equal(headers['X-Frame-Options'], 'DENY');
    assert.equal(headers['X-Content-Type-Options'], 'nosniff');
    assert.match(headers['Strict-Transport-Security'], /max-age=31536000/);
    assert.match(CSP, /frame-ancestors 'none'/);
    assert.doesNotMatch(CSP, /script-src[^;]*unsafe-inline/);
});
