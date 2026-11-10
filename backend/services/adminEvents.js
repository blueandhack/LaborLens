// Administrator audit trail: sign-ins, account changes, uploads and data clears.
// Events expire after 180 days. Passwords and tokens are never recorded.
const COLLECTION = 'admin_events';
const RETENTION_DAYS = 180;

// The visitor's address as reported by the ingress proxy (display only: it can
// be forged, so it must never decide access), and the socket address.
function requestInfo(req) {
    const forwarded = String(req.get?.('x-forwarded-for') || '').split(',')[0].trim().slice(0, 64);
    return { ip: forwarded || req.socket?.remoteAddress || null, userAgent: String(req.get?.('user-agent') || '').slice(0, 200) || null };
}

let indexed = null;
function ensureIndexes(db) {
    indexed ||= Promise.all([
        db.collection(COLLECTION).createIndex({ at: 1 }, { expireAfterSeconds: RETENTION_DAYS * 86400 }),
        db.collection(COLLECTION).createIndex({ type: 1, at: -1 }),
    ]).catch(error => { indexed = null; throw error; });
    return indexed;
}

// Records an event without delaying or failing the request.
function recordAdminEvent(db, type, req, fields = {}) {
    if (!db) return Promise.resolve();
    const event = { type, at: new Date(), ...(req ? requestInfo(req) : {}), ...fields };
    return ensureIndexes(db).then(() => db.collection(COLLECTION).insertOne(event))
        .catch(error => console.error('Admin event not recorded:', error.message));
}

function recentAdminEvents(db, { limit = 25, since } = {}) {
    return db.collection(COLLECTION).find(since ? { at: { $gte: since } } : {}, { projection: { _id: 0 }, sort: { at: -1 }, limit, maxTimeMS: 2000 }).toArray();
}

module.exports = { COLLECTION, RETENTION_DAYS, requestInfo, recordAdminEvent, recentAdminEvents };
