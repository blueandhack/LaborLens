const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const Admin = require('../models/Admin');

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
}, 30 * 60 * 1000);

function getClientIP(req) {
    return (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
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

// Middleware to verify JWT token
const authMiddleware = (req, res, next) => {
    const token = req.header('Authorization')?.replace('Bearer ', '');

    if (!token) {
        return res.status(401).json({ error: 'Authentication required' });
    }

    try {
        const decoded = jwt.verify(token, JWT_SECRET);
        req.adminId = decoded.id;
        next();
    } catch (error) {
        res.status(401).json({ error: 'Invalid token' });
    }
};

// POST /api/admin/login
router.post('/login', async (req, res) => {
    const ip = getClientIP(req);
    const limit = checkRateLimit(ip);
    if (limit.blocked) {
        return res.status(429).json({ error: `Too many failed attempts. Try again in ${limit.secsLeft} seconds.` });
    }

    try {
        const { username, password } = req.body;

        const admin = await Admin.findOne({ username });
        const isMatch = admin ? await admin.comparePassword(password) : false;

        if (!admin || !isMatch) {
            recordFailure(ip);
            // Constant-time delay to slow automated attacks
            await new Promise(r => setTimeout(r, 1000));
            return res.status(401).json({ error: 'Invalid credentials' });
        }

        resetAttempts(ip);
        const token = jwt.sign({ id: admin._id, username: admin.username }, JWT_SECRET, { expiresIn: '24h' });
        res.json({ token, username: admin.username });
    } catch (error) {
        console.error('Login error:', error);
        res.status(500).json({ error: 'Server error' });
    }
});

// GET /api/admin/check-auth
router.get('/check-auth', authMiddleware, (req, res) => {
    // If middleware passes, token is valid
    res.json({ valid: true });
});

// POST /api/admin/change-password
router.post('/change-password', authMiddleware, async (req, res) => {
    try {
        const { currentPassword, newPassword } = req.body;

        const admin = await Admin.findById(req.adminId);
        if (!admin) {
            return res.status(404).json({ error: 'Admin not found' });
        }

        const isMatch = await admin.comparePassword(currentPassword);
        if (!isMatch) {
            return res.status(400).json({ error: 'Incorrect current password' });
        }

        if (!newPassword || newPassword.length < 12) {
            return res.status(400).json({ error: 'New password must be at least 12 characters' });
        }

        admin.password = newPassword;
        await admin.save(); // Password will be hashed by pre-save hook

        res.json({ message: 'Password updated successfully' });
    } catch (error) {
        console.error('Change password error:', error);
        res.status(500).json({ error: 'Server error' });
    }
});

module.exports = { router, authMiddleware };
