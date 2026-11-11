const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
    clientAddress, createLimiter, passwordProblem, base32Encode, base32Decode, totpCode, verifyTotp, otpauthUrl,
    newRecoveryCodes, looksLikeRecoveryCode, createSecretBox, newTotpSecret,
} = require('../services/adminSecurity');

const request = (headers = {}, remoteAddress = '10.42.0.7') => ({ get: name => headers[name.toLowerCase()], socket: { remoteAddress } });

test('the client address comes from Cloudflare, not the ingress proxy', () => {
    assert.equal(clientAddress(request({ 'cf-connecting-ip': '203.0.113.9', 'x-forwarded-for': '172.70.1.1' })), '203.0.113.9');
    assert.equal(clientAddress(request({ 'x-forwarded-for': '198.51.100.4, 10.0.0.1' })), '198.51.100.4');
    assert.equal(clientAddress(request({ 'cf-connecting-ip': 'not-an-ip; DROP' })), '10.42.0.7', 'malformed headers are ignored');
    assert.equal(clientAddress(request({}, '::ffff:192.0.2.5')), '192.0.2.5');
    assert.equal(clientAddress(request({ 'cf-connecting-ip': '2001:db8::1' })), '2001:db8::1');
});

test('attempt limits lock after the maximum, expire, and forget old failures', () => {
    const limit = createLimiter({ max: 3, windowMs: 60000, lockMs: 120000 });
    const t0 = 1_000_000;
    assert.deepEqual(limit.fail('a', 'a', t0), { count: 1, locked: false, justLocked: false });
    limit.fail('a', 'a', t0 + 1);
    assert.equal(limit.fail('a', 'a', t0 + 2).justLocked, true);
    assert.deepEqual(limit.check('a', t0 + 3), { blocked: true, secsLeft: 120 });
    assert.equal(limit.locked(t0 + 3)[0].key, 'a');
    assert.equal(limit.check('a', t0 + 2 + 120000).blocked, false, 'a lock ends');
    limit.fail('b', 'b', t0); limit.fail('b', 'b', t0 + 1);
    assert.equal(limit.fail('b', 'b', t0 + 61000).count, 1, 'failures outside the window are forgotten');
    limit.reset('b');
    assert.equal(limit.check('b', t0).blocked, false);
});

test('password rules refuse short, common, sequential and username-based passwords', () => {
    assert.equal(passwordProblem('short'), 'Use at least 12 characters');
    assert.equal(passwordProblem('x'.repeat(201)), 'Use at most 200 characters');
    assert.equal(passwordProblem('aaaaaaaaaaaaaaaa'), 'Use more different characters');
    assert.equal(passwordProblem('Password1234'), 'That password is too common');
    assert.equal(passwordProblem('qwertyuiop123'), 'That password is too common');
    assert.equal(passwordProblem('abcdefghijklmnop'), 'Avoid simple sequences such as abcd or 1234');
    assert.equal(passwordProblem('123456789012'), 'Avoid simple sequences such as abcd or 1234');
    assert.equal(passwordProblem('zyxwvutsrqponm'), 'Avoid simple sequences such as abcd or 1234', 'backwards too');
    assert.equal(passwordProblem('blueandhack-2026!', { username: 'BlueAndHack' }), 'Do not include your username');
    assert.equal(passwordProblem('a brand new password'), null);
    assert.equal(passwordProblem('tidy-orbit-canvas-73', { username: 'admin' }), null);
    assert.equal(passwordProblem({ length: 20 }), 'Enter a new password');
});

test('authenticator codes match RFC 6238 and cannot be replayed', () => {
    // RFC 6238 test secret: ASCII "12345678901234567890".
    const secret = base32Encode(Buffer.from('12345678901234567890'));
    assert.equal(secret, 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
    assert.equal(base32Decode(secret).toString(), '12345678901234567890');
    assert.equal(totpCode(secret, Math.floor(59 / 30)), '287082');
    assert.equal(totpCode(secret, Math.floor(1111111109 / 30)), '081804');
    assert.equal(totpCode(secret, Math.floor(1234567890 / 30)), '005924');

    const now = 1111111109 * 1000, step = Math.floor(1111111109 / 30);
    assert.equal(verifyTotp(secret, '081804', { now }), step);
    assert.equal(verifyTotp(secret, '081 804', { now }), step, 'spaces are allowed');
    assert.equal(verifyTotp(secret, totpCode(secret, step - 1), { now }), step - 1, 'one step of clock drift is accepted');
    assert.equal(verifyTotp(secret, totpCode(secret, step - 2), { now }), null, 'older codes are not');
    assert.equal(verifyTotp(secret, '081804', { now, lastStep: step }), null, 'a used code is refused');
    for (const bad of ['', '12345', '1234567', 'abcdef', null, undefined, { $ne: 1 }]) assert.equal(verifyTotp(secret, bad, { now }), null);
    assert.equal(newTotpSecret().length, 32, '160-bit secrets');
    assert.match(otpauthUrl(secret, 'yoga@x'), /^otpauth:\/\/totp\/LaborLens%3Ayoga%40x\?secret=GEZ.*&issuer=LaborLens/);
});

test('recovery codes are random, readable, and stored only as keyed hashes; secrets are encrypted', () => {
    const codes = newRecoveryCodes();
    assert.equal(codes.length, 10);
    assert.equal(new Set(codes).size, 10);
    for (const code of codes) { assert.match(code, /^[a-hj-km-np-z2-9]{5}-[a-hj-km-np-z2-9]{5}$/); assert.ok(looksLikeRecoveryCode(code)); }
    assert.ok(!looksLikeRecoveryCode('123456'));

    const box = createSecretBox('server secret');
    assert.equal(box.hashRecoveryCode('ABCDE-FGHJK'), box.hashRecoveryCode('abcde fghjk'), 'case and separators do not matter');
    assert.notEqual(box.hashRecoveryCode('abcde-fghjk'), createSecretBox('other secret').hashRecoveryCode('abcde-fghjk'));
    const sealed = box.seal('GEZDGNBVGY3TQOJQ');
    assert.ok(sealed.startsWith('v1:') && !sealed.includes('GEZDGNBVGY3TQOJQ'));
    assert.equal(box.open(sealed), 'GEZDGNBVGY3TQOJQ');
    assert.throws(() => createSecretBox('other secret').open(sealed), 'another key cannot read it');
    assert.throws(() => box.open(sealed.slice(0, -4) + 'AAAA'), 'tampering is detected');
});
