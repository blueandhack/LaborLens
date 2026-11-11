// Helpers for the Access & security tab and the administrator sign-in.

// ── Password rules ───────────────────────────────────────────────────────────
// Mirrors backend/services/adminSecurity.js so problems show while typing; the
// server still decides.
export const PASSWORD_MIN = 12;
export const PASSWORD_MAX = 200;
const COMMON = new Set(['password', 'passwords', 'password1', 'password12', 'password123', 'password1234', 'passw0rd', 'p@ssw0rd', 'p@ssword', 'qwerty', 'qwertyuiop',
  'qwertyuiop123', '1q2w3e4r5t6y', '1qaz2wsx3edc', 'asdfghjkl', 'zxcvbnm', 'letmein', 'welcome', 'welcome123', 'iloveyou', 'admin', 'administrator', 'changeme', 'trustno1',
  'football', 'baseball', 'superman', 'batman', 'dragon', 'monkey', 'sunshine', 'princess', 'starwars', 'laborlens', 'labor lens', 'correcthorsebatterystaple']);
const SEQUENCES = ['abcdefghijklmnopqrstuvwxyzabcdefghijklmnopqrstuvwxyz', '0123456789'.repeat(4), 'qwertyuiopasdfghjklzxcvbnm'];
const reversed = text => [...text].reverse().join('');

// Each rule with whether the password meets it, for a live checklist.
export function passwordChecks(password, { username } = {}) {
  const value = String(password || '');
  const lower = value.toLowerCase(), compact = lower.replace(/[\s_.-]+/g, '');
  const name = String(username || '').toLowerCase();
  const common = COMMON.has(lower) || COMMON.has(compact) || COMMON.has(compact.replace(/\d+$/, ''));
  const sequence = compact.length > 0 && SEQUENCES.some(sequence => sequence.includes(compact) || reversed(sequence).includes(compact));
  const hasName = name.length >= 3 && (lower.includes(name) || compact.includes(name.replace(/[\s_.@-]+/g, '')));
  return [
    { id: 'length', label: `At least ${PASSWORD_MIN} characters`, ok: value.length >= PASSWORD_MIN && value.length <= PASSWORD_MAX },
    { id: 'variety', label: 'Not a repeated or simple pattern', ok: value.length > 0 && new Set(value).size >= 5 && !sequence },
    { id: 'common', label: 'Not a common password', ok: value.length > 0 && !common },
    { id: 'username', label: 'Does not include your username', ok: value.length > 0 && !hasName },
  ];
}

// A rough strength estimate (0–4) from length and the kinds of characters used.
// Long passphrases score well without symbols, matching current guidance.
export function passwordStrength(password, options) {
  const value = String(password || '');
  if (!value) return { score: 0, label: '' };
  const pools = [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].reduce((sum, re, i) => sum + (re.test(value) ? [26, 26, 10, 33][i] : 0), 0);
  const unique = new Set(value).size;
  const bits = Math.min(value.length, unique * 2) * Math.log2(Math.max(pools, 2));
  let score = bits < 40 ? 1 : bits < 60 ? 2 : bits < 80 ? 3 : 4;
  if (!passwordChecks(value, options).every(check => check.ok)) score = Math.min(score, 1);
  return { score, label: ['', 'Weak', 'Fair', 'Good', 'Strong'][score] };
}

// ── Devices and history ─────────────────────────────────────────────────────
// A short browser and system name from a user-agent string.
export function describeDevice(agent) {
  if (!agent) return 'Unknown device';
  const browser = /Edg\//.test(agent) ? 'Edge' : /Firefox\//.test(agent) ? 'Firefox' : /Chrome\//.test(agent) ? 'Chrome' : /Safari\//.test(agent) ? 'Safari'
    : /curl|node|python|undici/i.test(agent) ? 'Script' : 'Browser';
  const system = /iPhone/.test(agent) ? 'iPhone' : /iPad/.test(agent) ? 'iPad' : /Android/.test(agent) ? 'Android' : /Mac OS X|Macintosh/.test(agent) ? 'macOS'
    : /Windows/.test(agent) ? 'Windows' : /Linux/.test(agent) ? 'Linux' : '';
  return [browser, system].filter(Boolean).join(' on ');
}
export const isPhone = agent => /iPhone|Android.*Mobile/.test(agent || '');

const EVENTS = {
  'sign-in': ['Signed in', 'ok'], 'sign-out': ['Signed out', 'ok'], 'sign-in-failed': ['Failed sign-in', 'error'], 'sign-in-blocked': ['Sign-in blocked', 'error'],
  'account-locked': ['Account locked', 'error'], 'two-factor-failed': ['Wrong sign-in code', 'error'], 'password-check-failed': ['Wrong current password', 'error'],
  'two-factor-check-failed': ['Wrong code', 'error'], 'password-changed': ['Password changed', 'ok'], 'username-changed': ['Username changed', 'ok'],
  'two-factor-enabled': ['Two-factor sign-in turned on', 'ok'], 'two-factor-disabled': ['Two-factor sign-in turned off', 'warning'],
  'recovery-codes-replaced': ['New recovery codes', 'ok'], 'session-ended': ['Session signed out', 'ok'], 'other-sessions-ended': ['Other sessions signed out', 'ok'],
  'address-unblocked': ['Address unblocked', 'warning'], 'account-unlocked': ['Account unlocked', 'warning'],
};
export function describeSecurityEvent(event) {
  const [label, tone] = EVENTS[event.type] || [event.type, 'ok'];
  const who = event.unknownAccount ? 'unknown account' : event.username || '';
  const detail = event.type === 'username-changed' ? `${event.from} → ${event.username}`
    : event.type === 'sign-in' && event.twoFactor ? `${who} · ${event.twoFactor === 'recovery-code' ? 'recovery code' : 'authenticator code'}`
      : event.type === 'other-sessions-ended' ? `${who} · ${event.count} ended`
        : event.type === 'account-unlocked' ? `${who} unlocked ${event.account}`
          : event.type === 'address-unblocked' ? `${who} unblocked ${event.address}`
            : event.type === 'sign-in-blocked' && event.reason === 'account' ? `${who} · account locked` : who;
  return { label, tone, detail };
}

// The recovery codes as a text file to keep.
export function recoveryCodesFile(codes, username, now = new Date()) {
  return [`LaborLens administrator recovery codes for ${username}`, `Created ${now.toISOString().slice(0, 10)}. Each code works once.`,
    'Use one when you cannot get a code from your authenticator app.', '', ...codes, ''].join('\n');
}

// ── Requests ────────────────────────────────────────────────────────────────
// Signed-in API calls. A 401 means the session ended elsewhere (signed out, expired,
// or ended from another device); the page listens for this event and shows sign-in.
export const SESSION_ENDED_EVENT = 'laborlens:admin-session-ended';
export async function adminRequest(path, { method, body } = {}) {
  const token = localStorage.getItem('adminToken');
  const response = await fetch(path, {
    method: method || (body ? 'POST' : 'GET'),
    headers: { Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await response.json().catch(() => ({}));
  if (response.status === 401 && path !== '/api/admin/login' && !path.startsWith('/api/admin/login/')) window.dispatchEvent(new Event(SESSION_ENDED_EVENT));
  if (!response.ok) throw Object.assign(new Error(data.error || 'Something went wrong. Please try again.'), { status: response.status, data });
  return data;
}
