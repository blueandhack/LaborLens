const { test } = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const express = require('express');
const jwt = require('jsonwebtoken');
const { randomUUID } = require('node:crypto');

process.env.JWT_SECRET ||= 'test-secret-' + randomUUID();
const Admin = require('../models/Admin');
const { router, authMiddleware } = require('../routes/admin');
const { totpCode, totpStep } = require('../services/adminSecurity');

test('administrators can change their username safely', { skip: !process.env.MONGO_TEST_URI }, async t => {
    await mongoose.connect(process.env.MONGO_TEST_URI, { dbName: 'admin_' + randomUUID().replaceAll('-', '') });
    await Admin.init();
    t.after(async () => { await mongoose.connection.dropDatabase(); await mongoose.disconnect(); });
    const app = express(); app.use(express.json()); app.use('/api/admin', router);
    app.get('/api/protected', authMiddleware, (req, res) => res.json({ ok: true }));
    const server = app.listen(0); t.after(() => server.close());
    const base = `http://127.0.0.1:${server.address().port}`;
    const call = (path, { token, body, method = body ? 'POST' : 'GET', headers = {} } = {}) => fetch(base + path, { method,
        headers: { 'Content-Type': 'application/json', ...headers, ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: body && JSON.stringify(body) })
        .then(async response => ({ status: response.status, body: await response.json() }));
    const password = 'correct horse battery';
    // An account created before token versions existed (no tokenVersion field).
    const { insertedId } = await mongoose.connection.db.collection('admins').insertOne({ username: 'admin', password: await require('bcryptjs').hash(password, 4) });
    await Admin.create({ username: 'Other.Admin', password: 'another password 123' });
    await Admin.create({ username: 'third', password: 'third password 1234' });
    // A token issued before this change carries no version.
    const legacy = jwt.sign({ id: String(insertedId), username: 'admin' }, process.env.JWT_SECRET, { expiresIn: '1h' });
    assert.equal((await call('/api/protected', { token: legacy })).status, 401, 'tokens without a server-side session are refused');

    await t.test('login accepts only plain strings', async () => {
        assert.equal((await call('/api/admin/login', { body: { username: { $ne: null }, password } })).status, 401);
        assert.equal((await call('/api/admin/login', { body: { username: 'admin', password: { $ne: null } } })).status, 401);
    });
    let token = (await call('/api/admin/login', { body: { username: 'admin', password } })).body.token;
    const otherSession = token;
    const upgraded = await mongoose.connection.db.collection('admins').findOne({ _id: insertedId });
    assert.equal(require('bcryptjs').getRounds(upgraded.password), 12, 'a weaker hash is upgraded at sign-in');
    assert.equal(upgraded.updatedAt, undefined, 'without counting as an account change');

    await t.test('rejects a wrong password and invalid or taken usernames without changing anything', async () => {
        assert.deepEqual(await call('/api/admin/change-username', { token, body: { currentPassword: 'wrong', newUsername: 'newname' } }),
            { status: 400, body: { error: 'Incorrect current password' } });
        assert.equal((await call('/api/admin/change-username', { token, body: { newUsername: 'newname' } })).status, 400, 'password required');
        for (const newUsername of ['ab', 'has space', 'ádmin', 'x'.repeat(65), { $gt: '' }, ['admin2'], '', null])
            assert.equal((await call('/api/admin/change-username', { token, body: { currentPassword: password, newUsername } })).status, 400, JSON.stringify(newUsername));
        assert.equal((await call('/api/admin/change-username', { token, body: { currentPassword: password, newUsername: 'admin' } })).status, 400, 'same name');
        const taken = await call('/api/admin/change-username', { token, body: { currentPassword: password, newUsername: 'other.ADMIN' } });
        assert.deepEqual(taken, { status: 409, body: { error: 'That username is not available' } }, 'names differing only in case are taken');
        assert.equal(await Admin.countDocuments({ username: 'admin' }), 1);
        assert.equal((await call('/api/admin/change-username', { body: { currentPassword: password, newUsername: 'newname' } })).status, 401, 'sign-in required');
    });

    await t.test('a successful change signs out other sessions and returns a new token', async () => {
        const changed = await call('/api/admin/change-username', { token, body: { currentPassword: password, newUsername: '  yoga.admin@example  ' } });
        assert.equal(changed.status, 200); assert.equal(changed.body.username, 'yoga.admin@example');
        assert.equal((await call('/api/protected', { token: otherSession })).status, 401, 'older tokens stop working');
        assert.equal((await call('/api/protected', { token: legacy })).status, 401);
        token = changed.body.token;
        assert.deepEqual((await call('/api/admin/check-auth', { token })).body, { valid: true, username: 'yoga.admin@example' });
        assert.equal((await call('/api/admin/login', { body: { username: 'admin', password } })).status, 401, 'the old name no longer signs in');
        const login = await call('/api/admin/login', { body: { username: 'yoga.admin@example', password } });
        assert.equal(login.status, 200);
        const stored = await Admin.findById(insertedId).lean();
        assert.equal(stored.tokenVersion, 1); assert.equal(await require('bcryptjs').compare(password, stored.password), true, 'the password is unchanged');
        token = login.body.token;
    });

    await t.test('a password change also signs out other sessions', async () => {
        const before = token;
        const changed = await call('/api/admin/change-password', { token, body: { currentPassword: password, newPassword: 'a brand new password' } });
        assert.equal(changed.status, 200);
        assert.equal((await call('/api/protected', { token: before })).status, 401);
        assert.equal((await call('/api/protected', { token: changed.body.token })).status, 200);
        assert.equal((await call('/api/admin/change-password', { token: changed.body.token, body: { currentPassword: 'a brand new password', newPassword: { length: 20 } } })).status, 400);
    });

    await t.test('tokens with another algorithm or for a deleted account are refused', async () => {
        const forged = jwt.sign({ id: String(insertedId), v: 2 }, process.env.JWT_SECRET, { algorithm: 'HS512' });
        assert.equal((await call('/api/protected', { token: forged })).status, 401);
        const third = await Admin.findOne({ username: 'third' });
        const thirdToken = (await call('/api/admin/login', { body: { username: 'third', password: 'third password 1234' } })).body.token;
        await third.deleteOne();
        assert.equal((await call('/api/protected', { token: thirdToken })).status, 401);
    });

    await t.test('the audit trail records sign-ins and changes, never an unknown typed name', async () => {
        await call('/api/admin/login', { body: { username: 'my-secret-password', password: 'x' } });
        await new Promise(resolve => setTimeout(resolve, 200));
        const events = await mongoose.connection.db.collection('admin_events').find({}, { projection: { _id: 0 } }).sort({ at: 1 }).toArray();
        const types = events.map(event => event.type);
        for (const type of ['sign-in', 'sign-in-failed', 'username-changed', 'password-changed', 'password-check-failed']) assert.ok(types.includes(type), type);
        const unknown = events.filter(event => event.type === 'sign-in-failed' && event.unknownAccount);
        assert.ok(unknown.length >= 1);
        assert.ok(!JSON.stringify(events).includes('my-secret-password'), 'typed names of unknown accounts are not stored');
        assert.ok(!JSON.stringify(events).includes(password), 'passwords are never stored');
        assert.deepEqual(events.find(event => event.type === 'username-changed').from, 'admin');
        const indexes = await mongoose.connection.db.collection('admin_events').indexes();
        assert.equal(indexes.find(index => index.key.at === 1).expireAfterSeconds, 180 * 86400);
    });

    await t.test('the overview needs a sign-in and summarizes the site', async () => {
        assert.equal((await call('/api/admin/overview')).status, 401);
        const token = (await call('/api/admin/login', { body: { username: 'yoga.admin@example', password: 'a brand new password' } })).body.token;
        await mongoose.connection.db.collection('discovery_state').insertOne({ _id: 'backup', state: 'succeeded', lastSuccess: { completedAt: new Date(), archiveBytes: 123 } });
        const { status, body } = await call('/api/admin/overview', { token });
        assert.equal(status, 200);
        assert.deepEqual(body.datasets.map(row => row.program), ['pwd', 'perm', 'h1b']);
        assert.equal(body.viewer, 'yoga.admin@example');
        assert.equal(body.jobs.backup.lastSuccess.archiveBytes, 123);
        assert.ok(body.database.collections >= 2 && body.server.node.startsWith('v'));
        assert.ok(body.security.admins.some(admin => admin.username === 'yoga.admin@example'));
        assert.ok(body.security.failedSignIns24h >= 1);
        assert.ok(body.activity.some(item => item.type === 'username-changed'));
        assert.ok(!JSON.stringify(body).includes('"password"'), 'no password hashes leave the server');
    });

    await t.test('repeated wrong passwords lock that account’s changes', async () => {
        const other = (await call('/api/admin/login', { body: { username: 'Other.Admin', password: 'another password 123' } })).body.token;
        for (let i = 0; i < 5; i++) await call('/api/admin/change-username', { token: other, body: { currentPassword: 'guess' + i, newUsername: 'stolen' } });
        const locked = await call('/api/admin/change-username', { token: other, body: { currentPassword: 'another password 123', newUsername: 'stolen' } });
        assert.equal(locked.status, 429);
        assert.equal(await Admin.countDocuments({ username: 'Other.Admin' }), 1);
    });
    await t.test('signing out ends the session on the server, and sessions can be listed and ended', async () => {
        const login = () => call('/api/admin/login', { body: { username: 'yoga.admin@example', password: 'a brand new password' }, headers: { 'user-agent': 'Mozilla/5.0 (Macintosh) Firefox/130.0' } });
        const first = (await login()).body.token, second = (await login()).body.token, third = (await login()).body.token;
        assert.equal((await call('/api/admin/logout', { token: first, body: {} })).status, 200);
        assert.equal((await call('/api/protected', { token: first })).status, 401, 'a signed-out token stops working at once');

        const settings = await call('/api/admin/security', { token: second });
        assert.equal(settings.status, 200);
        const current = settings.body.sessions.find(session => session.current);
        assert.ok(current && settings.body.sessions.length >= 2);
        assert.match(current.userAgent, /Firefox/);
        assert.equal(settings.body.twoFactor.enabled, false);
        assert.ok(!JSON.stringify(settings.body).includes('password"'), 'no hashes');
        const thirdId = settings.body.sessions.find(session => !session.current).id;
        assert.equal((await call('/api/admin/sessions/' + thirdId, { token: second, method: 'DELETE' })).status, 200);
        assert.equal((await call('/api/protected', { token: third })).status, 401);
        assert.equal((await call('/api/admin/sessions/' + thirdId, { token: second, method: 'DELETE' })).status, 404);
        const fourth = (await login()).body.token;
        const ended = await call('/api/admin/sessions/end-others', { token: second, body: {} });
        assert.ok(ended.body.ended >= 1);
        assert.equal((await call('/api/protected', { token: fourth })).status, 401);
        assert.equal((await call('/api/protected', { token: second })).status, 200, 'the session that asked stays signed in');
        token = second;
    });

    await t.test('new passwords must not be common, contain the username, or repeat the current one', async () => {
        for (const [newPassword, error] of [['Password1234', 'That password is too common'], ['yoga.admin@example-2026', 'Do not include your username'],
            ['a brand new password', 'Choose a password different from your current one'], ['too short', 'Use at least 12 characters']]) {
            assert.deepEqual(await call('/api/admin/change-password', { token, body: { currentPassword: 'a brand new password', newPassword } }), { status: 400, body: { error } });
        }
    });

    await t.test('two-factor sign-in: setup, codes that cannot be replayed, recovery codes, and turning it off', async () => {
        assert.equal((await call('/api/admin/two-factor/setup', { token, body: { currentPassword: 'wrong' } })).status, 400, 'the password is required');
        const setup = await call('/api/admin/two-factor/setup', { token, body: { currentPassword: 'a brand new password' } });
        assert.equal(setup.status, 200);
        const secret = setup.body.secret.replaceAll(' ', '');
        assert.match(setup.body.qrSvg, /^<svg/);
        assert.match(setup.body.otpauthUrl, /issuer=LaborLens/);
        const stored = await Admin.findOne({ username: 'yoga.admin@example' }).lean();
        assert.ok(!JSON.stringify(stored).includes(secret), 'the secret is stored encrypted');

        const otherSession = (await call('/api/admin/login', { body: { username: 'yoga.admin@example', password: 'a brand new password' } })).body.token;
        assert.equal((await call('/api/admin/two-factor/enable', { token, body: { code: '000000' } })).status, 400);
        const enabled = await call('/api/admin/two-factor/enable', { token, body: { code: totpCode(secret, totpStep()) } });
        assert.equal(enabled.status, 200);
        assert.equal(enabled.body.recoveryCodes.length, 10);
        assert.equal((await call('/api/protected', { token: otherSession })).status, 401, 'password-only sessions end');
        assert.equal((await call('/api/protected', { token })).status, 200);
        const stillStored = await Admin.findOne({ username: 'yoga.admin@example' }).lean();
        assert.ok(!JSON.stringify(stillStored).includes(enabled.body.recoveryCodes[0]), 'recovery codes are stored hashed');

        const password = await call('/api/admin/login', { body: { username: 'yoga.admin@example', password: 'a brand new password' } });
        assert.equal(password.status, 200);
        assert.equal(password.body.twoFactorRequired, true);
        assert.equal(password.body.token, undefined, 'a password alone gives no session');
        const { challenge } = password.body;
        assert.equal((await call('/api/protected', { token: challenge })).status, 401, 'the challenge is not a sign-in');
        assert.equal((await call('/api/admin/login/two-factor', { body: { challenge: token, code: '123456' } })).body.restart, true, 'a session token is not a challenge');
        assert.equal((await call('/api/admin/login/two-factor', { body: { challenge, code: totpCode(secret, totpStep()) } })).status, 401, 'the code used to turn it on cannot be replayed');
        const signedIn = await call('/api/admin/login/two-factor', { body: { challenge, code: totpCode(secret, totpStep() + 1) } });
        assert.equal(signedIn.status, 200);
        assert.equal((await call('/api/protected', { token: signedIn.body.token })).status, 200);
        assert.equal((await call('/api/admin/login/two-factor', { body: { challenge, code: totpCode(secret, totpStep() + 1) } })).status, 401, 'nor can a sign-in code');

        const [first, second] = enabled.body.recoveryCodes;
        const recovered = await call('/api/admin/login/two-factor', { body: { challenge, code: first.toUpperCase() } });
        assert.equal(recovered.status, 200);
        assert.equal(recovered.body.recoveryCodesLeft, 9);
        assert.equal((await call('/api/admin/login/two-factor', { body: { challenge, code: first } })).status, 401, 'a recovery code works once');
        const settings = await call('/api/admin/security', { token: recovered.body.token });
        assert.deepEqual([settings.body.twoFactor.enabled, settings.body.twoFactor.recoveryCodesLeft], [true, 9]);

        assert.equal((await call('/api/admin/two-factor/disable', { token, body: { currentPassword: 'a brand new password', code: '000000' } })).status, 400, 'a code is required');
        assert.equal((await call('/api/admin/two-factor/disable', { token, body: { currentPassword: 'a brand new password', code: second } })).status, 200);
        const plain = await call('/api/admin/login', { body: { username: 'yoga.admin@example', password: 'a brand new password' } });
        assert.ok(plain.body.token && !plain.body.twoFactorRequired);
        const types = (await call('/api/admin/security-events', { token })).body.map(event => event.type);
        for (const type of ['two-factor-enabled', 'two-factor-failed', 'two-factor-disabled', 'sign-out', 'session-ended', 'other-sessions-ended']) assert.ok(types.includes(type), type);
        const failed = (await call('/api/admin/security-events?filter=failed', { token })).body;
        assert.ok(failed.length && failed.every(event => /failed|blocked|locked/.test(event.type)));
    });

    await t.test('failed sign-ins are limited per visitor address and per account', async () => {
        await Admin.create({ username: 'locktest', password: 'locktest password 99' });
        const from = ip => ({ 'cf-connecting-ip': ip });
        const attempt = (ip, pass = 'wrong password') => call('/api/admin/login', { body: { username: 'locktest', password: pass }, headers: from(ip) });
        await Promise.all(['192.0.2.1', '192.0.2.1', '192.0.2.1', '192.0.2.1', '192.0.2.1'].map(ip => attempt(ip)));
        assert.equal((await attempt('192.0.2.1', 'locktest password 99')).status, 429, 'that address is blocked');
        assert.equal((await attempt('192.0.2.2', 'locktest password 99')).status, 200, 'other visitors are not');
        await Promise.all(Array.from({ length: 10 }, (_, i) => attempt('198.51.100.' + (i + 1))));
        assert.equal((await attempt('198.51.100.99', 'locktest password 99')).status, 429, 'changing addresses does not get around the account limit');
        assert.equal((await call('/api/admin/login', { body: { username: 'yoga.admin@example', password: 'a brand new password' }, headers: from('198.51.100.98') })).status, 200, 'other accounts can still sign in');
        const lockouts = (await call('/api/admin/security', { token })).body.lockouts;
        assert.ok(lockouts.addresses.some(item => item.ip === '192.0.2.1'));
        const account = lockouts.accounts.find(item => item.username === 'locktest');
        assert.ok(account);
        assert.equal((await call('/api/admin/lockouts/account/' + account.id, { token, method: 'DELETE' })).status, 200);
        assert.equal((await attempt('198.51.100.99', 'locktest password 99')).status, 200, 'an unlocked account signs in');
        assert.equal((await call('/api/admin/lockouts/address/192.0.2.1', { token, method: 'DELETE' })).status, 200);
    });
});
