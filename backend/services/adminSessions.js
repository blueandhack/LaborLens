// Administrator sessions. Each sign-in creates a record the sign-in token refers to,
// so a session can be listed, ended on its own, or ended everywhere, and signing out
// really ends it. Records expire on their own after the absolute lifetime.
const crypto = require('node:crypto');
const { clientAddress } = require('./adminSecurity');

const COLLECTION = 'admin_sessions';
const LIFETIME_MS = 24 * 3600 * 1000;      // matches the sign-in token's lifetime
const IDLE_MS = 12 * 3600 * 1000;          // unused this long, a session ends
const TOUCH_EVERY_MS = 60 * 1000;          // last-active is recorded at most once a minute

let indexed = null;
function ensureIndexes(db) {
    indexed ||= Promise.all([
        db.collection(COLLECTION).createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
        db.collection(COLLECTION).createIndex({ adminId: 1, lastSeenAt: -1 }),
    ]).catch(error => { indexed = null; throw error; });
    return indexed;
}

const userAgentOf = req => String(req.get?.('user-agent') || '').slice(0, 300) || null;

async function createSession(db, adminId, req, { twoFactor = null } = {}) {
    await ensureIndexes(db);
    const now = new Date();
    const session = { _id: crypto.randomBytes(18).toString('base64url'), adminId: String(adminId), createdAt: now, lastSeenAt: now,
        expiresAt: new Date(now.getTime() + LIFETIME_MS), ip: clientAddress(req), userAgent: userAgentOf(req), twoFactor };
    await db.collection(COLLECTION).insertOne(session);
    return session;
}

// The live session for this administrator, or null when it was ended, expired, or idle too long.
async function findSession(db, sessionId, adminId, now = Date.now()) {
    if (typeof sessionId !== 'string' || sessionId.length > 64) return null;
    const session = await db.collection(COLLECTION).findOne({ _id: sessionId, adminId: String(adminId) }, { maxTimeMS: 2000 });
    if (!session || session.expiresAt <= new Date(now) || now - session.lastSeenAt.getTime() > IDLE_MS) return null;
    return session;
}

function touchSession(db, session, req, now = Date.now()) {
    if (now - session.lastSeenAt.getTime() < TOUCH_EVERY_MS) return Promise.resolve();
    return db.collection(COLLECTION).updateOne({ _id: session._id }, { $set: { lastSeenAt: new Date(now), ip: clientAddress(req), userAgent: userAgentOf(req) } })
        .catch(error => console.error('Session activity not recorded:', error.message));
}

async function listSessions(db, adminId, now = Date.now()) {
    const sessions = await db.collection(COLLECTION).find({ adminId: String(adminId), expiresAt: { $gt: new Date(now) }, lastSeenAt: { $gt: new Date(now - IDLE_MS) } },
        { sort: { lastSeenAt: -1 }, limit: 50, maxTimeMS: 2000 }).toArray();
    return sessions.map(session => ({ id: session._id, createdAt: session.createdAt, lastSeenAt: session.lastSeenAt, expiresAt: session.expiresAt,
        ip: session.ip, userAgent: session.userAgent, twoFactor: session.twoFactor || null }));
}

const endSession = (db, adminId, sessionId) => db.collection(COLLECTION).deleteOne({ _id: String(sessionId), adminId: String(adminId) }).then(result => result.deletedCount);
const endOtherSessions = (db, adminId, keepId) => db.collection(COLLECTION).deleteMany({ adminId: String(adminId), _id: { $ne: String(keepId) } }).then(result => result.deletedCount);
const countSessions = (db, adminId, now = Date.now()) => db.collection(COLLECTION).countDocuments(
    { adminId: String(adminId), expiresAt: { $gt: new Date(now) }, lastSeenAt: { $gt: new Date(now - IDLE_MS) } }, { maxTimeMS: 2000 });

module.exports = { COLLECTION, LIFETIME_MS, IDLE_MS, createSession, findSession, touchSession, listSessions, endSession, endOtherSessions, countSessions };
