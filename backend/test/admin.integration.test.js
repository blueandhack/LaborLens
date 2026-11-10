const { test } = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const express = require('express');
const jwt = require('jsonwebtoken');
const { randomUUID } = require('node:crypto');

process.env.JWT_SECRET ||= 'test-secret-' + randomUUID();
const Admin = require('../models/Admin');
const { router, authMiddleware } = require('../routes/admin');

test('administrators can change their username safely', { skip: !process.env.MONGO_TEST_URI }, async t => {
    await mongoose.connect(process.env.MONGO_TEST_URI, { dbName: 'admin_' + randomUUID().replaceAll('-', '') });
    await Admin.init();
    t.after(async () => { await mongoose.connection.dropDatabase(); await mongoose.disconnect(); });
    const app = express(); app.use(express.json()); app.use('/api/admin', router);
    app.get('/api/protected', authMiddleware, (req, res) => res.json({ ok: true }));
    const server = app.listen(0); t.after(() => server.close());
    const base = `http://127.0.0.1:${server.address().port}`;
    const call = (path, { token, body, method = body ? 'POST' : 'GET' } = {}) => fetch(base + path, { method,
        headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: body && JSON.stringify(body) })
        .then(async response => ({ status: response.status, body: await response.json() }));
    const password = 'correct horse battery';
    // An account created before token versions existed (no tokenVersion field).
    const { insertedId } = await mongoose.connection.db.collection('admins').insertOne({ username: 'admin', password: await require('bcryptjs').hash(password, 4) });
    await Admin.create({ username: 'Other.Admin', password: 'another password 123' });
    await Admin.create({ username: 'third', password: 'third password 1234' });
    // A token issued before this change carries no version.
    const legacy = jwt.sign({ id: String(insertedId), username: 'admin' }, process.env.JWT_SECRET, { expiresIn: '1h' });
    assert.equal((await call('/api/protected', { token: legacy })).status, 200, 'existing sessions keep working until a change');

    await t.test('login accepts only plain strings', async () => {
        assert.equal((await call('/api/admin/login', { body: { username: { $ne: null }, password } })).status, 401);
        assert.equal((await call('/api/admin/login', { body: { username: 'admin', password: { $ne: null } } })).status, 401);
    });
    let token = (await call('/api/admin/login', { body: { username: 'admin', password } })).body.token;
    const otherSession = token;

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
});
