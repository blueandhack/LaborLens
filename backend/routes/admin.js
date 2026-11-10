const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');
const Admin = require('../models/Admin');
const { getSiteStatus } = require('../services/siteStatus');
const { getAdminOverview } = require('../services/adminOverview');
const { recordAdminEvent } = require('../services/adminEvents');
const audit = (type, req, fields) => recordAdminEvent(mongoose.connection.db, type, req, fields);

const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
    console.error('FATAL: JWT_SECRET environment variable is not set');
    process.exit(1);
}

// ── Brute-force protection (in-memory per IP) ──────────────────────────────
const MAX_ATTEMPTS = 5;
const LOCKOUT_MS = 15 * 60 * 1000; // 15 minutes
const loginAttempts = new Map(); // ip → { count, lockedUntil }

// Clean up stale entries every 30 minutes so the Map doesn't grow unbounded
setInterval(() => {
    const now = Date.now();
    for (const [ip, state] of loginAttempts) {
        if (state.lockedUntil && now > state.lockedUntil) loginAttempts.delete(ip);
    }
}, 30 * 60 * 1000).unref();

function getClientIP(req) {
    return req.socket.remoteAddress || '';
}

function checkRateLimit(ip) {
    const now = Date.now();
    const state = loginAttempts.get(ip) || { count: 0, lockedUntil: null };
    if (state.lockedUntil && now < state.lockedUntil) {
        const secsLeft = Math.ceil((state.lockedUntil - now) / 1000);
        return { blocked: true, secsLeft };
    }
    if (state.lockedUntil && now >= state.lockedUntil) {
        loginAttempts.delete(ip);
    }
    return { blocked: false };
}

function recordFailure(ip) {
    const state = loginAttempts.get(ip) || { count: 0, lockedUntil: null };
    state.count += 1;
    if (state.count >= MAX_ATTEMPTS) {
        state.lockedUntil = Date.now() + LOCKOUT_MS;
    }
    loginAttempts.set(ip, state);
}

function resetAttempts(ip) {
    loginAttempts.delete(ip);
}

// Re-entering the current password (to change the username or password) is
// limited per account, so a stolen sign-in token cannot be used to guess it.
const reauthAttempts = new Map(); // admin id → { count, lockedUntil }
function checkAccountLimit(id) {
    const state = reauthAttempts.get(id);
    if (state?.lockedUntil && Date.now() < state.lockedUntil) return { blocked: true, secsLeft: Math.ceil((state.lockedUntil - Date.now()) / 1000) };
    if (state?.lockedUntil) reauthAttempts.delete(id);
    return { blocked: false };
}
function recordAccountFailure(id) {
    const state = reauthAttempts.get(id) || { count: 0, lockedUntil: null };
    state.count += 1;
    if (state.count >= MAX_ATTEMPTS) state.lockedUntil = Date.now() + LOCKOUT_MS;
    reauthAttempts.set(id, state);
}
const FAILURE_DELAY_MS = 1000;
const slow = () => new Promise(r => setTimeout(r, FAILURE_DELAY_MS));

const signToken = admin => jwt.sign({ id: String(admin._id), username: admin.username, v: admin.tokenVersion || 0 }, JWT_SECRET,
    { expiresIn: '24h', algorithm: 'HS256' });

// Middleware to verify JWT token: signature, expiry, and that the account still
// exists with the same token version (username and password changes raise it).
const authMiddleware = async (req, res, next) => {
    const token = req.header('Authorization')?.replace('Bearer ', '');

    if (!token) {
        return res.status(401).json({ error: 'Authentication required' });
    }

    let decoded;
    try {
        decoded = jwt.verify(token, JWT_SECRET, { algorithms: ['HS256'] });
    } catch {
        return res.status(401).json({ error: 'Invalid token' });
    }
    if (typeof decoded.id !== 'string' || !mongoose.isValidObjectId(decoded.id)) return res.status(401).json({ error: 'Invalid token' });
    try {
        const admin = await Admin.findById(decoded.id, { tokenVersion: 1, username: 1 }).lean();
        if (!admin || (admin.tokenVersion || 0) !== (decoded.v || 0)) {
            return res.status(401).json({ error: 'Your session has ended. Please sign in again.' });
        }
        req.adminId = String(admin._id);
        req.adminUsername = admin.username;
        next();
    } catch (error) {
        console.error('Auth check error:', error.message);
        res.status(503).json({ error: 'Sign-in could not be checked. Please try again.' });
    }
};

// Loads the signed-in admin and checks the current password, with the per-account limit.
async function reauthenticate(req, res) {
    const limit = checkAccountLimit(req.adminId);
    if (limit.blocked) {
        res.status(429).json({ error: `Too many incorrect passwords. Try again in ${limit.secsLeft} seconds.` });
        return null;
    }
    const admin = await Admin.findById(req.adminId);
    if (!admin) {
        res.status(401).json({ error: 'Your session has ended. Please sign in again.' });
        return null;
    }
    const { currentPassword } = req.body || {};
    const isMatch = typeof currentPassword === 'string' && currentPassword.length > 0 && await admin.comparePassword(currentPassword);
    if (!isMatch) {
        recordAccountFailure(req.adminId);
        audit('password-check-failed', req, { username: admin.username });
        await slow();
        res.status(400).json({ error: 'Incorrect current password' });
        return null;
    }
    reauthAttempts.delete(req.adminId);
    return admin;
}

// POST /api/admin/login
router.post('/login', async (req, res) => {
    const ip = getClientIP(req);
    const limit = checkRateLimit(ip);
    if (limit.blocked) {
        audit('sign-in-blocked', req);
        return res.status(429).json({ error: `Too many failed attempts. Try again in ${limit.secsLeft} seconds.` });
    }

    try {
        const { username, password } = req.body || {};

        // Only plain strings: a query object here must never reach MongoDB.
        const admin = typeof username === 'string' && typeof password === 'string' && username.length <= 200
            ? await Admin.findOne({ username: username.trim() }) : null;
        const isMatch = admin ? await admin.comparePassword(password) : false;

        if (!admin || !isMatch) {
            recordFailure(ip);
            // The attempted name is kept only for a real account: a mistyped
            // password entered as the username must not be stored.
            audit('sign-in-failed', req, admin ? { username: admin.username } : { unknownAccount: true });
            // Constant-time delay to slow automated attacks
            await slow();
            return res.status(401).json({ error: 'Invalid credentials' });
        }

        resetAttempts(ip);
        audit('sign-in', req, { username: admin.username });
        res.json({ token: signToken(admin), username: admin.username });
    } catch (error) {
        console.error('Login error:', error);
        res.status(500).json({ error: 'Server error' });
    }
});

// GET /api/admin/check-auth
router.get('/check-auth', authMiddleware, (req, res) => {
    // If middleware passes, token is valid
    res.json({ valid: true, username: req.adminUsername });
});

// POST /api/admin/change-password
// Signs out every other session; the response carries a new token for this one.
router.post('/change-password', authMiddleware, async (req, res) => {
    try {
        const admin = await reauthenticate(req, res);
        if (!admin) return;

        const { newPassword } = req.body;
        if (typeof newPassword !== 'string' || newPassword.length < 12) {
            return res.status(400).json({ error: 'New password must be at least 12 characters' });
        }
        if (newPassword.length > 200) {
            return res.status(400).json({ error: 'New password must be at most 200 characters' });
        }

        admin.password = newPassword;
        admin.tokenVersion = (admin.tokenVersion || 0) + 1;
        await admin.save(); // Password will be hashed by pre-save hook
        console.log(JSON.stringify({ event: 'admin-password-changed', adminId: req.adminId, username: admin.username, ip: getClientIP(req), at: new Date().toISOString() }));
        audit('password-changed', req, { username: admin.username });

        res.json({ message: 'Password updated successfully', token: signToken(admin), username: admin.username });
    } catch (error) {
        console.error('Change password error:', error);
        res.status(500).json({ error: 'Server error' });
    }
});

// POST /api/admin/change-username { currentPassword, newUsername }
// Signs out every other session; the response carries a new token for this one.
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
        console.log(JSON.stringify({ event: 'admin-username-changed', adminId: req.adminId, from: admin.username, to: username, ip: getClientIP(req), at: new Date().toISOString() }));
        audit('username-changed', req, { username, from: admin.username });

        res.json({ message: 'Username updated', token: signToken(updated), username: updated.username });
    } catch (error) {
        if (error?.code === 11000) return res.status(409).json({ error: 'That username is not available' });
        console.error('Change username error:', error);
        res.status(500).json({ error: 'Server error' });
    }
});

// GET /api/admin/overview — the administration dashboard
router.get('/overview', authMiddleware, async (req, res) => {
    try {
        const now = Date.now();
        const blocked = [...loginAttempts.values()].filter(state => state.lockedUntil && now < state.lockedUntil);
        res.set('Cache-Control', 'no-store').json({ ...(await getAdminOverview(mongoose.connection.db, { blocked })), viewer: req.adminUsername });
    } catch (error) {
        console.error('Admin overview error:', error.message);
        res.status(503).set('Cache-Control', 'no-store').json({ error: 'The overview is temporarily unavailable.' });
    }
});

// GET /api/admin/site-status — background refresh and summary status
router.get('/site-status', authMiddleware, async (req, res) => {
    try {
        res.set('Cache-Control', 'no-store').json(await getSiteStatus(mongoose.connection.db));
    } catch (error) {
        console.error('Site status error:', error.message);
        res.status(503).set('Cache-Control', 'no-store').json({ error: 'Site data status is temporarily unavailable.' });
    }
});

// GET /api/admin/blocked-ips
router.get('/blocked-ips', authMiddleware, (req, res) => {
    const now = Date.now();
    const blocked = [];
    for (const [ip, state] of loginAttempts) {
        if (state.lockedUntil && now < state.lockedUntil) {
            blocked.push({
                ip,
                attempts: state.count,
                lockedUntil: new Date(state.lockedUntil).toISOString(),
                secsLeft: Math.ceil((state.lockedUntil - now) / 1000),
            });
        }
    }
    blocked.sort((a, b) => b.secsLeft - a.secsLeft);
    res.json(blocked);
});

// DELETE /api/admin/blocked-ips/:ip
router.delete('/blocked-ips/:ip', authMiddleware, (req, res) => {
    const ip = req.params.ip;
    if (loginAttempts.has(ip)) {
        loginAttempts.delete(ip);
        audit('address-unblocked', req, { username: req.adminUsername, address: ip.slice(0, 64) });
        res.json({ message: `Unblocked ${ip}` });
    } else {
        res.status(404).json({ error: 'IP not found or not blocked' });
    }
});

module.exports = { router, authMiddleware };
