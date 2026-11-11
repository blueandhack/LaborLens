const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const mongoose = require('mongoose');
const QRCode = require('qrcode');
const Admin = require('../models/Admin');
const { getSiteStatus } = require('../services/siteStatus');
const { getAdminOverview } = require('../services/adminOverview');
const { recordAdminEvent, COLLECTION: EVENTS } = require('../services/adminEvents');
const {
    clientAddress, createLimiter, passwordProblem, newTotpSecret, verifyTotp, otpauthUrl,
    newRecoveryCodes, looksLikeRecoveryCode, createSecretBox,
} = require('../services/adminSecurity');
const sessions = require('../services/adminSessions');

const db = () => mongoose.connection.db;
const audit = (type, req, fields) => recordAdminEvent(db(), type, req, fields);

const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
    console.error('FATAL: JWT_SECRET environment variable is not set');
    process.exit(1);
}
// Authenticator secrets are encrypted with a key derived from JWT_SECRET. Changing
// JWT_SECRET makes them unreadable; administrators then sign in with a recovery code.
const secretBox = createSecretBox(JWT_SECRET);
const CHALLENGE_AUDIENCE = 'laborlens-two-factor';

// Nothing an administrator endpoint returns may be cached (tokens, secrets, codes).
router.use((req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });

// ── Attempt limits (in memory, per server) ──────────────────────────────────
// Per address: slows one source. Per account: holds even when addresses change or
// are forged. Re-entry: a stolen session cannot guess the password or a code.
const WINDOW_MS = 15 * 60 * 1000, LOCK_MS = 15 * 60 * 1000;
const addressLimit = createLimiter({ max: 5, windowMs: WINDOW_MS, lockMs: LOCK_MS });
const accountLimit = createLimiter({ max: 10, windowMs: WINDOW_MS, lockMs: LOCK_MS });
const reauthLimit = createLimiter({ max: 5, windowMs: WINDOW_MS, lockMs: LOCK_MS });
setInterval(() => { for (const limit of [addressLimit, accountLimit, reauthLimit]) limit.sweep(); }, 10 * 60 * 1000).unref();

const FAILURE_DELAY_MS = 1000;
const slow = () => new Promise(r => setTimeout(r, FAILURE_DELAY_MS));
const waitText = secs => secs < 90 ? `${secs} seconds` : `${Math.ceil(secs / 60)} minutes`;
const tooMany = secs => `Too many failed attempts. Try again in ${waitText(secs)}.`;
// Unknown usernames are checked against this hash so a reply takes as long either way.
const DUMMY_HASH = bcrypt.hashSync('laborlens-timing-equalizer', Admin.BCRYPT_COST);

const signToken = (admin, sessionId) => jwt.sign({ id: String(admin._id), username: admin.username, v: admin.tokenVersion || 0, sid: sessionId }, JWT_SECRET,
    { expiresIn: '24h', algorithm: 'HS256' });

// Verifies the sign-in token (signature, expiry), that the account still exists with
// the same token version (password and username changes raise it), and that its
// session is still open (signing out or ending a session closes it).
const authMiddleware = async (req, res, next) => {
    const token = req.header('Authorization')?.replace('Bearer ', '');
    if (!token) return res.status(401).json({ error: 'Authentication required' });

    let decoded;
    try {
        decoded = jwt.verify(token, JWT_SECRET, { algorithms: ['HS256'] });
    } catch {
        return res.status(401).json({ error: 'Invalid token' });
    }
    if (typeof decoded.id !== 'string' || !mongoose.isValidObjectId(decoded.id) || typeof decoded.sid !== 'string' || decoded.aud) {
        return res.status(401).json({ error: 'Your session has ended. Please sign in again.' });
    }
    try {
        const admin = await Admin.findById(decoded.id, { tokenVersion: 1, username: 1 }).lean();
        const session = admin && (admin.tokenVersion || 0) === (decoded.v || 0) ? await sessions.findSession(db(), decoded.sid, admin._id) : null;
        if (!session) return res.status(401).json({ error: 'Your session has ended. Please sign in again.' });
        sessions.touchSession(db(), session, req);
        req.adminId = String(admin._id);
        req.adminUsername = admin.username;
        req.sessionId = session._id;
        next();
    } catch (error) {
        console.error('Auth check error:', error.message);
        res.status(503).json({ error: 'Sign-in could not be checked. Please try again.' });
    }
};

// Loads the signed-in admin and checks the current password, with the per-account limit.
async function reauthenticate(req, res) {
    const limit = reauthLimit.check(req.adminId);
    if (limit.blocked) {
        res.status(429).json({ error: `Too many incorrect attempts. Try again in ${waitText(limit.secsLeft)}.` });
        return null;
    }
    const admin = await Admin.findById(req.adminId);
    if (!admin) {
        res.status(401).json({ error: 'Your session has ended. Please sign in again.' });
        return null;
    }
    const { currentPassword } = req.body || {};
    const isMatch = typeof currentPassword === 'string' && currentPassword.length > 0 && currentPassword.length <= 200 && await admin.comparePassword(currentPassword);
    if (!isMatch) {
        reauthLimit.fail(req.adminId, admin.username);
        audit('password-check-failed', req, { username: admin.username });
        await slow();
        res.status(400).json({ error: 'Incorrect current password' });
        return null;
    }
    return admin;
}

// Checks an authenticator code or a recovery code and uses it up, atomically, so the
// same code cannot be accepted twice even by two requests at once.
async function useSecondFactor(admin, code) {
    if (!admin.twoFactor?.enabledAt || typeof code !== 'string' || code.length > 40) return null;
    if (looksLikeRecoveryCode(code)) {
        const hash = secretBox.hashRecoveryCode(code);
        const used = await Admin.updateOne({ _id: admin._id, 'twoFactor.recoveryCodes': hash }, { $pull: { 'twoFactor.recoveryCodes': hash } }, { timestamps: false });
        return used.modifiedCount ? { method: 'recovery-code', recoveryCodesLeft: admin.twoFactor.recoveryCodes.length - 1 } : null;
    }
    let secret;
    try { secret = secretBox.open(admin.twoFactor.secret); } catch { return null; }
    const lastStep = admin.twoFactor.lastStep ?? -1;
    const step = verifyTotp(secret, code, { lastStep });
    if (step === null) return null;
    const used = await Admin.updateOne({ _id: admin._id, 'twoFactor.enabledAt': { $exists: true }, 'twoFactor.lastStep': lastStep },
        { $set: { 'twoFactor.lastStep': step } }, { timestamps: false });
    return used.modifiedCount ? { method: 'app' } : null;
}

async function completeSignIn(admin, req, res, address, secondFactor) {
    addressLimit.reset(address);
    accountLimit.reset(String(admin._id));
    const session = await sessions.createSession(db(), admin._id, req, { twoFactor: secondFactor?.method || null });
    audit('sign-in', req, { username: admin.username, ...(secondFactor ? { twoFactor: secondFactor.method } : {}) });
    res.json({ token: signToken(admin, session._id), username: admin.username,
        ...(secondFactor?.method === 'recovery-code' ? { recoveryCodesLeft: secondFactor.recoveryCodesLeft } : {}) });
}

// POST /api/admin/login { username, password }
// With two-factor sign-in on, the reply is { twoFactorRequired, challenge } and the
// sign-in finishes at /login/two-factor.
router.post('/login', async (req, res) => {
    const address = clientAddress(req);
    const byAddress = addressLimit.check(address);
    if (byAddress.blocked) {
        audit('sign-in-blocked', req);
        return res.status(429).json({ error: tooMany(byAddress.secsLeft) });
    }

    try {
        const { username, password } = req.body || {};
        // Only plain strings: a query object here must never reach MongoDB.
        const valid = typeof username === 'string' && typeof password === 'string' && username.length <= 200 && password.length <= 200;
        const admin = valid ? await Admin.findOne({ username: username.trim() }) : null;
        if (admin) {
            const byAccount = accountLimit.check(String(admin._id));
            if (byAccount.blocked) {
                audit('sign-in-blocked', req, { username: admin.username, reason: 'account' });
                await slow();
                return res.status(429).json({ error: tooMany(byAccount.secsLeft) });
            }
        }
        let isMatch = false;
        if (admin) isMatch = await admin.comparePassword(password);
        else if (valid) await bcrypt.compare(password, DUMMY_HASH);

        if (!admin || !isMatch) {
            addressLimit.fail(address);
            if (admin && accountLimit.fail(String(admin._id), admin.username).justLocked) audit('account-locked', req, { username: admin.username });
            // The attempted name is kept only for a real account: a mistyped
            // password entered as the username must not be stored.
            audit('sign-in-failed', req, admin ? { username: admin.username } : { unknownAccount: true });
            await slow();
            return res.status(401).json({ error: 'Incorrect username or password' });
        }

        if (admin.needsRehash()) {
            admin.password = password;
            await admin.save({ timestamps: false });
        }
        if (admin.twoFactor?.enabledAt) {
            const challenge = jwt.sign({ id: String(admin._id), v: admin.tokenVersion || 0 }, JWT_SECRET,
                { expiresIn: '5m', algorithm: 'HS256', audience: CHALLENGE_AUDIENCE });
            return res.json({ twoFactorRequired: true, challenge });
        }
        await completeSignIn(admin, req, res, address, null);
    } catch (error) {
        console.error('Login error:', error);
        res.status(500).json({ error: 'Server error' });
    }
});

// POST /api/admin/login/two-factor { challenge, code } — code from the app, or a recovery code
router.post('/login/two-factor', async (req, res) => {
    const address = clientAddress(req);
    const byAddress = addressLimit.check(address);
    if (byAddress.blocked) return res.status(429).json({ error: tooMany(byAddress.secsLeft) });
    try {
        const { challenge, code } = req.body || {};
        let decoded = null;
        try { decoded = typeof challenge === 'string' ? jwt.verify(challenge, JWT_SECRET, { algorithms: ['HS256'], audience: CHALLENGE_AUDIENCE }) : null; } catch { /* expired or forged */ }
        const admin = decoded && mongoose.isValidObjectId(decoded.id) ? await Admin.findById(decoded.id) : null;
        if (!admin || (admin.tokenVersion || 0) !== (decoded.v || 0) || !admin.twoFactor?.enabledAt) {
            return res.status(401).json({ error: 'This sign-in expired. Enter your username and password again.', restart: true });
        }
        const byAccount = accountLimit.check(String(admin._id));
        if (byAccount.blocked) return res.status(429).json({ error: tooMany(byAccount.secsLeft), restart: true });

        const used = await useSecondFactor(admin, code);
        if (!used) {
            addressLimit.fail(address);
            if (accountLimit.fail(String(admin._id), admin.username).justLocked) audit('account-locked', req, { username: admin.username });
            audit('two-factor-failed', req, { username: admin.username });
            await slow();
            return res.status(401).json({ error: 'That code did not work. Enter the current code from your app, or a recovery code.' });
        }
        await completeSignIn(admin, req, res, address, used);
    } catch (error) {
        console.error('Two-factor sign-in error:', error);
        res.status(500).json({ error: 'Server error' });
    }
});

// GET /api/admin/check-auth
router.get('/check-auth', authMiddleware, (req, res) => {
    res.json({ valid: true, username: req.adminUsername });
});

// POST /api/admin/logout — ends this session on the server, not just in the browser
router.post('/logout', authMiddleware, async (req, res) => {
    try {
        await sessions.endSession(db(), req.adminId, req.sessionId);
        audit('sign-out', req, { username: req.adminUsername });
        res.json({ ok: true });
    } catch (error) {
        console.error('Sign-out error:', error.message);
        res.status(503).json({ error: 'Sign-out could not be completed. Please try again.' });
    }
});

// POST /api/admin/change-password { currentPassword, newPassword }
// Ends every other session; the response carries a new token for this one.
router.post('/change-password', authMiddleware, async (req, res) => {
    try {
        const admin = await reauthenticate(req, res);
        if (!admin) return;

        const { newPassword } = req.body;
        const problem = passwordProblem(newPassword, { username: admin.username });
        if (problem) return res.status(400).json({ error: problem });
        if (await admin.comparePassword(newPassword)) return res.status(400).json({ error: 'Choose a password different from your current one' });

        admin.password = newPassword;
        admin.passwordChangedAt = new Date();
        admin.tokenVersion = (admin.tokenVersion || 0) + 1;
        await admin.save(); // Password will be hashed by pre-save hook
        const ended = await sessions.endOtherSessions(db(), admin._id, req.sessionId);
        console.log(JSON.stringify({ event: 'admin-password-changed', adminId: req.adminId, username: admin.username, ip: clientAddress(req), at: new Date().toISOString() }));
        reauthLimit.reset(req.adminId);
        audit('password-changed', req, { username: admin.username, endedSessions: ended });

        res.json({ message: 'Password updated successfully', token: signToken(admin, req.sessionId), username: admin.username, endedSessions: ended });
    } catch (error) {
        console.error('Change password error:', error);
        res.status(500).json({ error: 'Server error' });
    }
});

// POST /api/admin/change-username { currentPassword, newUsername }
// Ends every other session; the response carries a new token for this one.
router.post('/change-username', authMiddleware, async (req, res) => {
    try {
        const admin = await reauthenticate(req, res);
        if (!admin) return;

        const username = Admin.normalizeUsername(req.body.newUsername);
        if (!username) {
            return res.status(400).json({ error: 'Usernames are 3 to 64 characters: letters, digits, and . _ @ - only' });
        }
        if (username === admin.username) {
            return res.status(400).json({ error: 'That is already your username' });
        }
        // Names differing only in letter case are too easy to confuse.
        const taken = await Admin.exists({ _id: { $ne: admin._id }, username }).collation({ locale: 'en', strength: 2 });
        if (taken) {
            return res.status(409).json({ error: 'That username is not available' });
        }

        // One atomic update, only if the account has not changed since it was checked.
        const updated = await Admin.findOneAndUpdate(
            // Accounts created before token versions have no field yet: version 0.
            { _id: admin._id, username: admin.username, tokenVersion: admin.tokenVersion ? admin.tokenVersion : { $in: [0, null] } },
            { $set: { username }, $inc: { tokenVersion: 1 } },
            { new: true });
        if (!updated) {
            return res.status(409).json({ error: 'Your account changed in the meantime. Please sign in again.' });
        }
        const ended = await sessions.endOtherSessions(db(), admin._id, req.sessionId);
        console.log(JSON.stringify({ event: 'admin-username-changed', adminId: req.adminId, from: admin.username, to: username, ip: clientAddress(req), at: new Date().toISOString() }));
        reauthLimit.reset(req.adminId);
        audit('username-changed', req, { username, from: admin.username, endedSessions: ended });

        res.json({ message: 'Username updated', token: signToken(updated, req.sessionId), username: updated.username, endedSessions: ended });
    } catch (error) {
        if (error?.code === 11000) return res.status(409).json({ error: 'That username is not available' });
        console.error('Change username error:', error);
        res.status(500).json({ error: 'Server error' });
    }
});

// ── Security settings ───────────────────────────────────────────────────────
const lockouts = () => ({
    addresses: addressLimit.locked().map(({ key, attempts, lockedUntil, secsLeft }) => ({ ip: key, attempts, lockedUntil, secsLeft })),
    accounts: accountLimit.locked().map(({ key, label, attempts, lockedUntil, secsLeft }) => ({ id: key, username: label, attempts, lockedUntil, secsLeft })),
});

// GET /api/admin/security — your account, two-factor status, sessions, and lockouts
router.get('/security', authMiddleware, async (req, res) => {
    try {
        const admin = await Admin.findById(req.adminId, { username: 1, createdAt: 1, passwordChangedAt: 1, 'twoFactor.enabledAt': 1, 'twoFactor.recoveryCodes': 1 }).lean();
        if (!admin) return res.status(401).json({ error: 'Your session has ended. Please sign in again.' });
        const list = await sessions.listSessions(db(), req.adminId);
        res.json({
            username: admin.username, createdAt: admin.createdAt || null, passwordChangedAt: admin.passwordChangedAt || null,
            twoFactor: { enabled: Boolean(admin.twoFactor?.enabledAt), enabledAt: admin.twoFactor?.enabledAt || null, recoveryCodesLeft: admin.twoFactor?.recoveryCodes?.length ?? 0 },
            sessions: list.map(session => ({ ...session, current: session.id === req.sessionId })),
            lockouts: lockouts(),
            policy: { sessionHours: sessions.LIFETIME_MS / 3600000, idleHours: sessions.IDLE_MS / 3600000 },
        });
    } catch (error) {
        console.error('Security settings error:', error.message);
        res.status(503).json({ error: 'Security settings are temporarily unavailable.' });
    }
});

// GET /api/admin/security-events?filter=failed — sign-in and account history
const SECURITY_EVENTS = ['sign-in', 'sign-in-failed', 'sign-in-blocked', 'account-locked', 'two-factor-failed', 'sign-out', 'password-check-failed', 'password-changed',
    'username-changed', 'two-factor-enabled', 'two-factor-disabled', 'two-factor-check-failed', 'recovery-codes-replaced', 'session-ended', 'other-sessions-ended',
    'address-unblocked', 'account-unlocked'];
const FAILED_EVENTS = ['sign-in-failed', 'sign-in-blocked', 'account-locked', 'two-factor-failed', 'password-check-failed', 'two-factor-check-failed'];
router.get('/security-events', authMiddleware, async (req, res) => {
    try {
        const types = req.query.filter === 'failed' ? FAILED_EVENTS : SECURITY_EVENTS;
        const events = await db().collection(EVENTS).find({ type: { $in: types } }, { projection: { _id: 0 }, sort: { at: -1 }, limit: 100, maxTimeMS: 3000 }).toArray();
        res.json(events);
    } catch (error) {
        console.error('Security events error:', error.message);
        res.status(503).json({ error: 'Sign-in history is temporarily unavailable.' });
    }
});

// DELETE /api/admin/sessions/:id — ends one of your sessions (your own: signs you out)
router.delete('/sessions/:id', authMiddleware, async (req, res) => {
    try {
        const ended = await sessions.endSession(db(), req.adminId, req.params.id);
        if (!ended) return res.status(404).json({ error: 'That session has already ended' });
        audit('session-ended', req, { username: req.adminUsername, current: req.params.id === req.sessionId });
        res.json({ ok: true, signedOut: req.params.id === req.sessionId });
    } catch (error) {
        console.error('End session error:', error.message);
        res.status(503).json({ error: 'The session could not be ended. Please try again.' });
    }
});

// POST /api/admin/sessions/end-others — signs out everywhere else
router.post('/sessions/end-others', authMiddleware, async (req, res) => {
    try {
        const ended = await sessions.endOtherSessions(db(), req.adminId, req.sessionId);
        audit('other-sessions-ended', req, { username: req.adminUsername, count: ended });
        res.json({ ok: true, ended });
    } catch (error) {
        console.error('End sessions error:', error.message);
        res.status(503).json({ error: 'Sessions could not be ended. Please try again.' });
    }
});

// DELETE /api/admin/lockouts/address/:ip and /lockouts/account/:id
router.delete('/lockouts/address/:ip', authMiddleware, (req, res) => {
    const ip = req.params.ip;
    if (!addressLimit.check(ip).blocked) return res.status(404).json({ error: 'That address is not blocked' });
    addressLimit.reset(ip);
    audit('address-unblocked', req, { username: req.adminUsername, address: ip.slice(0, 64) });
    res.json({ ok: true });
});
router.delete('/lockouts/account/:id', authMiddleware, (req, res) => {
    const entry = accountLimit.locked().find(item => item.key === req.params.id);
    if (!entry) return res.status(404).json({ error: 'That account is not locked' });
    accountLimit.reset(req.params.id);
    audit('account-unlocked', req, { username: req.adminUsername, account: entry.label });
    res.json({ ok: true });
});

// ── Two-factor sign-in ──────────────────────────────────────────────────────
const SETUP_MINUTES = 15;

// POST /api/admin/two-factor/setup { currentPassword } → a new secret to add to an app
router.post('/two-factor/setup', authMiddleware, async (req, res) => {
    try {
        const admin = await reauthenticate(req, res);
        if (!admin) return;
        if (admin.twoFactor?.enabledAt) return res.status(400).json({ error: 'Two-factor sign-in is already on' });
        const secret = newTotpSecret();
        await Admin.updateOne({ _id: admin._id }, { $set: { pendingTwoFactor: { secret: secretBox.seal(secret), createdAt: new Date() } } }, { timestamps: false });
        const url = otpauthUrl(secret, admin.username);
        const qrSvg = await QRCode.toString(url, { type: 'svg', errorCorrectionLevel: 'M', margin: 1 });
        res.json({ secret: secret.match(/.{1,4}/g).join(' '), otpauthUrl: url, qrSvg, expiresInMinutes: SETUP_MINUTES });
    } catch (error) {
        console.error('Two-factor setup error:', error);
        res.status(500).json({ error: 'Server error' });
    }
});

// POST /api/admin/two-factor/enable { code } → turns it on; returns recovery codes once
router.post('/two-factor/enable', authMiddleware, async (req, res) => {
    try {
        const limit = reauthLimit.check(req.adminId);
        if (limit.blocked) return res.status(429).json({ error: `Too many incorrect attempts. Try again in ${waitText(limit.secsLeft)}.` });
        const admin = await Admin.findById(req.adminId);
        if (!admin) return res.status(401).json({ error: 'Your session has ended. Please sign in again.' });
        if (admin.twoFactor?.enabledAt) return res.status(400).json({ error: 'Two-factor sign-in is already on' });
        const pending = admin.pendingTwoFactor;
        if (!pending?.secret || Date.now() - new Date(pending.createdAt) > SETUP_MINUTES * 60000) {
            return res.status(400).json({ error: 'This setup expired. Start again.', restart: true });
        }
        let step = null;
        try { step = verifyTotp(secretBox.open(pending.secret), req.body?.code); } catch { /* unreadable secret */ }
        if (step === null) {
            reauthLimit.fail(req.adminId, admin.username);
            audit('two-factor-check-failed', req, { username: admin.username });
            await slow();
            return res.status(400).json({ error: 'That code did not work. Check that your phone’s clock is set automatically, then enter the newest code.' });
        }
        const recoveryCodes = newRecoveryCodes();
        await Admin.updateOne({ _id: admin._id, 'pendingTwoFactor.secret': pending.secret }, {
            $set: { twoFactor: { secret: pending.secret, enabledAt: new Date(), lastStep: step, recoveryCodes: recoveryCodes.map(secretBox.hashRecoveryCode) } },
            $unset: { pendingTwoFactor: 1 },
        });
        // Sessions opened with only a password end; this one stays.
        const ended = await sessions.endOtherSessions(db(), admin._id, req.sessionId);
        reauthLimit.reset(req.adminId);
        audit('two-factor-enabled', req, { username: admin.username, endedSessions: ended });
        res.json({ recoveryCodes, endedSessions: ended });
    } catch (error) {
        console.error('Two-factor enable error:', error);
        res.status(500).json({ error: 'Server error' });
    }
});

// Password and a current code (or a recovery code) for changes to two-factor sign-in.
async function reauthenticateWithCode(req, res) {
    const admin = await reauthenticate(req, res);
    if (!admin) return null;
    if (!admin.twoFactor?.enabledAt) { res.status(400).json({ error: 'Two-factor sign-in is off' }); return null; }
    if (!await useSecondFactor(admin, req.body?.code)) {
        reauthLimit.fail(req.adminId, admin.username);
        audit('two-factor-check-failed', req, { username: admin.username });
        await slow();
        res.status(400).json({ error: 'That code did not work. Enter the current code from your app, or a recovery code.' });
        return null;
    }
    return admin;
}

// POST /api/admin/two-factor/disable { currentPassword, code }
router.post('/two-factor/disable', authMiddleware, async (req, res) => {
    try {
        const admin = await reauthenticateWithCode(req, res);
        if (!admin) return;
        await Admin.updateOne({ _id: admin._id }, { $unset: { twoFactor: 1, pendingTwoFactor: 1 } });
        reauthLimit.reset(req.adminId);
        audit('two-factor-disabled', req, { username: admin.username });
        res.json({ ok: true });
    } catch (error) {
        console.error('Two-factor disable error:', error);
        res.status(500).json({ error: 'Server error' });
    }
});

// POST /api/admin/two-factor/recovery-codes { currentPassword, code } → a new set; old codes stop working
router.post('/two-factor/recovery-codes', authMiddleware, async (req, res) => {
    try {
        const admin = await reauthenticateWithCode(req, res);
        if (!admin) return;
        const recoveryCodes = newRecoveryCodes();
        await Admin.updateOne({ _id: admin._id }, { $set: { 'twoFactor.recoveryCodes': recoveryCodes.map(secretBox.hashRecoveryCode) } }, { timestamps: false });
        reauthLimit.reset(req.adminId);
        audit('recovery-codes-replaced', req, { username: admin.username });
        res.json({ recoveryCodes });
    } catch (error) {
        console.error('Recovery codes error:', error);
        res.status(500).json({ error: 'Server error' });
    }
});

// ── Dashboards ──────────────────────────────────────────────────────────────

// GET /api/admin/overview — the administration dashboard
router.get('/overview', authMiddleware, async (req, res) => {
    try {
        res.json({ ...(await getAdminOverview(db(), { blocked: addressLimit.locked() })), viewer: req.adminUsername });
    } catch (error) {
        console.error('Admin overview error:', error.message);
        res.status(503).json({ error: 'The overview is temporarily unavailable.' });
    }
});

// GET /api/admin/site-status — background refresh and summary status
router.get('/site-status', authMiddleware, async (req, res) => {
    try {
        res.json(await getSiteStatus(db()));
    } catch (error) {
        console.error('Site status error:', error.message);
        res.status(503).json({ error: 'Site data status is temporarily unavailable.' });
    }
});

module.exports = { router, authMiddleware };
