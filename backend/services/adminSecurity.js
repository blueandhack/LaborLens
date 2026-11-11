// Administrator sign-in security: client addresses, attempt limits, password rules,
// authenticator-app codes (TOTP, RFC 6238), recovery codes, and secret encryption.
// Everything here is pure or in-memory so it can be tested without a database.
const crypto = require('node:crypto');
const net = require('node:net');

// ── Client address ──────────────────────────────────────────────────────────
// Cloudflare sends the visitor's address in CF-Connecting-IP; Traefik forwards it
// unchanged. Without it, the socket address is the ingress proxy, shared by every
// visitor. A request that bypasses Cloudflare can forge this header, so addresses
// only slow guessing down; the per-account limit is what cannot be sidestepped.
const plainAddress = value => String(value || '').trim().replace(/^::ffff:(?=\d+\.\d+\.\d+\.\d+$)/, '');
function clientAddress(req) {
    for (const value of [req.get?.('cf-connecting-ip'), String(req.get?.('x-forwarded-for') || '').split(',')[0]]) {
        const address = plainAddress(value);
        if (net.isIP(address)) return address;
    }
    return plainAddress(req.socket?.remoteAddress) || 'unknown';
}

// ── Attempt limits ──────────────────────────────────────────────────────────
// Failures count within a window; reaching the limit locks the key for a while.
function createLimiter({ max, windowMs, lockMs }) {
    const entries = new Map(); // key → { count, first, lockedUntil, label }
    const live = (key, now) => {
        const entry = entries.get(key);
        if (!entry) return null;
        if (entry.lockedUntil ? now >= entry.lockedUntil : now - entry.first > windowMs) { entries.delete(key); return null; }
        return entry;
    };
    return {
        check(key, now = Date.now()) {
            const entry = live(key, now);
            return entry?.lockedUntil ? { blocked: true, secsLeft: Math.ceil((entry.lockedUntil - now) / 1000) } : { blocked: false };
        },
        fail(key, label = key, now = Date.now()) {
            const entry = live(key, now) || { count: 0, first: now, lockedUntil: null, label };
            entry.count += 1;
            const justLocked = entry.count >= max && !entry.lockedUntil;
            if (justLocked) entry.lockedUntil = now + lockMs;
            entries.set(key, entry);
            return { count: entry.count, locked: Boolean(entry.lockedUntil), justLocked };
        },
        reset: key => entries.delete(key),
        locked(now = Date.now()) {
            return [...entries.keys()].map(key => [key, live(key, now)]).filter(([, entry]) => entry?.lockedUntil)
                .map(([key, entry]) => ({ key, label: entry.label, attempts: entry.count, lockedUntil: new Date(entry.lockedUntil).toISOString(), secsLeft: Math.ceil((entry.lockedUntil - now) / 1000) }))
                .sort((a, b) => b.secsLeft - a.secsLeft);
        },
        sweep(now = Date.now()) { for (const key of entries.keys()) live(key, now); },
    };
}

// ── Password rules ──────────────────────────────────────────────────────────
// Length matters most (NIST SP 800-63B); composition rules are not required, but
// guessable choices are refused. The browser shows the same rules as you type.
const PASSWORD_MIN = 12, PASSWORD_MAX = 200;
const COMMON = new Set(['password', 'passwords', 'password1', 'password12', 'password123', 'password1234', 'passw0rd', 'p@ssw0rd', 'p@ssword', 'qwerty', 'qwertyuiop',
    'qwertyuiop123', '1q2w3e4r5t6y', '1qaz2wsx3edc', 'asdfghjkl', 'zxcvbnm', 'letmein', 'welcome', 'welcome123', 'iloveyou', 'admin', 'administrator', 'changeme', 'trustno1',
    'football', 'baseball', 'superman', 'batman', 'dragon', 'monkey', 'sunshine', 'princess', 'starwars', 'laborlens', 'labor lens', 'correcthorsebatterystaple']);
// Digits wrap around (…7890123…) as people type them.
const SEQUENCES = ['abcdefghijklmnopqrstuvwxyzabcdefghijklmnopqrstuvwxyz', '0123456789'.repeat(4), 'qwertyuiopasdfghjklzxcvbnm'];
function passwordProblem(password, { username } = {}) {
    if (typeof password !== 'string') return 'Enter a new password';
    if (password.length < PASSWORD_MIN) return `Use at least ${PASSWORD_MIN} characters`;
    if (password.length > PASSWORD_MAX) return `Use at most ${PASSWORD_MAX} characters`;
    const lower = password.toLowerCase(), compact = lower.replace(/[\s_.-]+/g, '');
    if (new Set(password).size < 5) return 'Use more different characters';
    if (COMMON.has(lower) || COMMON.has(compact) || COMMON.has(compact.replace(/\d+$/, ''))) return 'That password is too common';
    if (SEQUENCES.some(sequence => sequence.includes(compact) || [...sequence].reverse().join('').includes(compact))) return 'Avoid simple sequences such as abcd or 1234';
    const name = String(username || '').toLowerCase();
    if (name.length >= 3 && (lower.includes(name) || compact.includes(name.replace(/[\s_.@-]+/g, '')))) return 'Do not include your username';
    return null;
}

// ── Base32 (RFC 4648), used by authenticator apps ──────────────────────────
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
function base32Encode(buffer) {
    let bits = 0, value = 0, out = '';
    for (const byte of buffer) {
        value = (value << 8) | byte; bits += 8;
        while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5; }
    }
    if (bits > 0) out += B32[(value << (5 - bits)) & 31];
    return out;
}
function base32Decode(text) {
    const clean = String(text).toUpperCase().replace(/[\s=-]/g, '');
    let bits = 0, value = 0;
    const out = [];
    for (const char of clean) {
        const index = B32.indexOf(char);
        if (index < 0) throw new Error('Invalid base32');
        value = (value << 5) | index; bits += 5;
        if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; }
    }
    return Buffer.from(out);
}

// ── Authenticator-app codes (TOTP: SHA-1, 30-second steps, 6 digits) ────────
const STEP_SECONDS = 30;
const newTotpSecret = () => base32Encode(crypto.randomBytes(20));
const totpStep = (now = Date.now()) => Math.floor(now / 1000 / STEP_SECONDS);
function totpCode(secret, step) {
    const counter = Buffer.alloc(8);
    counter.writeBigUInt64BE(BigInt(step));
    const hash = crypto.createHmac('sha1', base32Decode(secret)).update(counter).digest();
    const offset = hash[hash.length - 1] & 15;
    return String((hash.readUInt32BE(offset) & 0x7fffffff) % 1e6).padStart(6, '0');
}
const sameText = (a, b) => a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
// The matching step (one step of clock drift either way), or null. A step at or
// before `lastStep` was already used and is refused, so an observed code cannot be replayed.
function verifyTotp(secret, code, { lastStep = -1, now = Date.now() } = {}) {
    const typed = String(code ?? '').replace(/\s+/g, '');
    if (!/^\d{6}$/.test(typed)) return null;
    const current = totpStep(now);
    let match = null;
    for (const step of [current - 1, current, current + 1]) if (sameText(totpCode(secret, step), typed) && step > lastStep) match = step;
    return match;
}
const otpauthUrl = (secret, account) => `otpauth://totp/${encodeURIComponent('LaborLens:' + account)}?secret=${secret}&issuer=LaborLens&algorithm=SHA1&digits=6&period=${STEP_SECONDS}`;

// ── Recovery codes ──────────────────────────────────────────────────────────
// Ten one-time codes of ten characters (about 49 bits each) without look-alike
// letters. Only keyed hashes are stored.
const RECOVERY_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';
function newRecoveryCodes(count = 10) {
    return Array.from({ length: count }, () => {
        const chars = Array.from(crypto.randomBytes(10), byte => RECOVERY_ALPHABET[byte % RECOVERY_ALPHABET.length]).join('');
        return chars.slice(0, 5) + '-' + chars.slice(5);
    });
}
const normalizeRecoveryCode = code => String(code ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
const looksLikeRecoveryCode = code => normalizeRecoveryCode(code).length === 10;

// ── Encryption of stored authenticator secrets (AES-256-GCM) ────────────────
function createSecretBox(masterSecret) {
    const key = Buffer.from(crypto.hkdfSync('sha256', String(masterSecret), 'laborlens-admin', 'two-factor-secret', 32));
    const hashKey = Buffer.from(crypto.hkdfSync('sha256', String(masterSecret), 'laborlens-admin', 'recovery-codes', 32));
    return {
        seal(text) {
            const iv = crypto.randomBytes(12);
            const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
            const body = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
            return 'v1:' + Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64');
        },
        open(sealed) {
            const raw = Buffer.from(String(sealed).replace(/^v1:/, ''), 'base64');
            const decipher = crypto.createDecipheriv('aes-256-gcm', key, raw.subarray(0, 12));
            decipher.setAuthTag(raw.subarray(12, 28));
            return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString('utf8');
        },
        hashRecoveryCode: code => crypto.createHmac('sha256', hashKey).update(normalizeRecoveryCode(code)).digest('hex'),
    };
}

module.exports = {
    clientAddress, createLimiter, passwordProblem, PASSWORD_MIN, PASSWORD_MAX,
    base32Encode, base32Decode, newTotpSecret, totpStep, totpCode, verifyTotp, otpauthUrl,
    newRecoveryCodes, normalizeRecoveryCode, looksLikeRecoveryCode, createSecretBox,
};
