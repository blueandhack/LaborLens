import { useCallback, useEffect, useState } from 'react';
import {
  FiAlertTriangle, FiCheck, FiCheckCircle, FiCopy, FiDownload, FiEye, FiEyeOff, FiKey, FiLogOut, FiMonitor, FiRefreshCw, FiShield, FiSmartphone, FiUnlock, FiUser, FiX, FiXCircle,
} from 'react-icons/fi';
import { adminRequest, describeDevice, describeSecurityEvent, isPhone, passwordChecks, passwordStrength, recoveryCodesFile } from '../utils/adminSecurity';
import { formatDate, formatDateTime, timeAgo } from '../utils/adminOverview';
import './AccessSecurity.css';

// Matches the server's rule (backend/models/Admin.js).
const USERNAME_PATTERN = /^[A-Za-z0-9._@-]{3,64}$/;
const LEVEL_ICON = { ok: FiCheckCircle, warning: FiAlertTriangle, error: FiXCircle };
const waitText = secs => secs < 90 ? `${secs}s` : `${Math.ceil(secs / 60)} min`;
const plural = (count, word) => `${count} ${word}${count === 1 ? '' : 's'}`;

// Runs a request, tracking busy state, an error, and a success notice.
function useAction() {
  const [state, setState] = useState({ busy: false, error: '', notice: '' });
  const run = useCallback(async (work) => {
    setState({ busy: true, error: '', notice: '' });
    try { const notice = await work(); setState({ busy: false, error: '', notice: notice || '' }); return true; }
    catch (error) { setState({ busy: false, error: error.message, notice: '' }); return false; }
  }, []);
  const clear = useCallback(() => setState({ busy: false, error: '', notice: '' }), []);
  return [state, run, clear];
}

function Notice({ state }) {
  if (state.error) return <p className="import-notice error" role="alert">{state.error}</p>;
  if (state.notice) return <p className="import-notice success" role="status">{state.notice}</p>;
  return null;
}

function PasswordField({ id, label, value, onChange, autoComplete, describedBy, autoFocus }) {
  const [shown, setShown] = useState(false);
  return (
    <label htmlFor={id}>{label}
      <span className="sec-password">
        <input id={id} type={shown ? 'text' : 'password'} autoComplete={autoComplete} className="search-input" value={value} maxLength={200}
          onChange={event => onChange(event.target.value)} aria-describedby={describedBy} autoFocus={autoFocus} spellCheck={false} autoCapitalize="none" required />
        <button type="button" className="sec-reveal" onClick={() => setShown(value => !value)} aria-label={shown ? 'Hide password' : 'Show password'} aria-pressed={shown}>
          {shown ? <FiEyeOff aria-hidden="true" /> : <FiEye aria-hidden="true" />}
        </button>
      </span>
    </label>
  );
}

// A six-digit code from the app; or, when allowed, a recovery code.
export function CodeField({ id, value, onChange, allowRecovery, autoFocus }) {
  const [recovery, setRecovery] = useState(false);
  return (
    <div className="sec-code-field">
      <label htmlFor={id}>{recovery ? 'Recovery code' : 'Code from your authenticator app'}
        <input id={id} className="search-input sec-code-input" value={value} autoFocus={autoFocus} required spellCheck={false} autoCapitalize="none"
          {...(recovery ? { autoComplete: 'off', maxLength: 20, placeholder: 'xxxxx-xxxxx' } : { inputMode: 'numeric', autoComplete: 'one-time-code', maxLength: 7, placeholder: '123456', pattern: '[0-9 ]{6,7}' })}
          onChange={event => onChange(recovery ? event.target.value : event.target.value.replace(/[^\d ]/g, ''))} />
      </label>
      {allowRecovery && <button type="button" className="sec-text-button" onClick={() => { setRecovery(value => !value); onChange(''); }}>
        {recovery ? 'Use a code from your app instead' : 'Use a recovery code instead'}</button>}
    </div>
  );
}

function StrengthMeter({ password, username }) {
  const { score, label } = passwordStrength(password, { username });
  const checks = passwordChecks(password, { username });
  return (
    <div className="sec-strength" aria-live="polite">
      <div className="sec-strength-bar" data-score={score}><span /><span /><span /><span /></div>
      <p className="sec-strength-label">{password ? <>Strength: <strong>{label}</strong></> : 'Use a long passphrase, such as four unrelated words.'}</p>
      <ul className="sec-checklist">{checks.map(check => (
        <li key={check.id} className={check.ok ? 'is-ok' : ''}>{check.ok ? <FiCheck aria-hidden="true" /> : <FiX aria-hidden="true" />}{check.label}
          <span className="sr-only">{check.ok ? ' (met)' : ' (not met)'}</span></li>
      ))}</ul>
    </div>
  );
}

// ── Checkup ──────────────────────────────────────────────────────────────────
function Checkup({ data, now }) {
  const twoFactor = data.twoFactor;
  const passwordSince = data.passwordChangedAt || data.createdAt;
  const passwordDays = passwordSince ? (now - new Date(passwordSince)) / 86400000 : Infinity;
  const blocked = data.lockouts.addresses.length + data.lockouts.accounts.length;
  const items = [
    { id: 'sec-two-factor', icon: FiSmartphone, label: 'Two-factor sign-in', value: twoFactor.enabled ? 'On' : 'Off',
      level: !twoFactor.enabled || twoFactor.recoveryCodesLeft <= 3 ? 'warning' : 'ok',
      detail: !twoFactor.enabled ? 'Ask for a code from your phone at every sign-in' : twoFactor.recoveryCodesLeft <= 3 ? `Only ${plural(twoFactor.recoveryCodesLeft, 'recovery code')} left` : `${twoFactor.recoveryCodesLeft} recovery codes left` },
    { id: 'sec-account', icon: FiKey, label: 'Password', value: `${data.passwordChangedAt ? 'Changed' : 'Set'} ${timeAgo(passwordSince, now)}`,
      level: passwordDays > 365 ? 'warning' : 'ok', detail: passwordDays > 365 ? 'Over a year old: consider a new one' : 'Checked against common passwords' },
    { id: 'sec-sessions', icon: FiMonitor, label: 'Signed-in sessions', value: plural(data.sessions.length, 'session'),
      level: 'ok', detail: data.sessions.length > 1 ? 'Sign out any you do not recognize' : 'Only this device' },
    { id: 'sec-protection', icon: FiShield, label: 'Sign-in protection', value: blocked ? `${blocked} locked out` : 'No lockouts',
      level: blocked ? 'warning' : 'ok', detail: 'Repeated failures pause sign-in for 15 minutes' },
  ];
  const review = items.filter(item => item.level !== 'ok').length;
  return (
    <section className={`sec-checkup is-${review ? 'warning' : 'ok'}`} aria-labelledby="sec-checkup-heading">
      <div className="sec-checkup-head">
        {review ? <FiAlertTriangle aria-hidden="true" /> : <FiCheckCircle aria-hidden="true" />}
        <div><p className="section-kicker">Security checkup</p>
          <h3 id="sec-checkup-heading">{review ? `${plural(review, 'item')} to review` : 'Your account is well protected'}</h3></div>
      </div>
      <ul className="sec-checkup-items">{items.map(item => {
        const Icon = LEVEL_ICON[item.level];
        return <li key={item.id} className={'is-' + item.level}>
          <a href={'#' + item.id}><span className="sec-checkup-label"><item.icon aria-hidden="true" />{item.label}</span>
            <strong><Icon aria-hidden="true" />{item.value}</strong><small>{item.detail}</small></a>
        </li>;
      })}</ul>
    </section>
  );
}

// ── Account: username and password ──────────────────────────────────────────
function AccountCard({ data, now, onTokenChange }) {
  const [editing, setEditing] = useState(null);
  const [state, run, clear] = useAction();
  const [form, setForm] = useState({ newUsername: '', currentPassword: '', newPassword: '', confirmPassword: '' });
  const set = key => value => setForm(current => ({ ...current, [key]: value }));
  const open = which => { setEditing(which); clear(); setForm({ newUsername: '', currentPassword: '', newPassword: '', confirmPassword: '' }); };
  const close = () => { setEditing(null); setForm({ newUsername: '', currentPassword: '', newPassword: '', confirmPassword: '' }); };
  const ended = count => count ? ` ${plural(count, 'other session')} signed out.` : '';

  const changeUsername = event => {
    event.preventDefault();
    const newUsername = form.newUsername.trim();
    run(async () => {
      if (!USERNAME_PATTERN.test(newUsername)) throw new Error('Use 3 to 64 characters: letters, digits, and . _ @ - only.');
      if (newUsername === data.username) throw new Error('That is already your username.');
      const result = await adminRequest('/api/admin/change-username', { body: { newUsername, currentPassword: form.currentPassword } });
      onTokenChange(result.token, result.username);
      close();
      return `Your username is now ${result.username}. Use it the next time you sign in.${ended(result.endedSessions)}`;
    });
  };
  const passwordReady = passwordChecks(form.newPassword, { username: data.username }).every(check => check.ok) && form.newPassword === form.confirmPassword && form.currentPassword;
  const changePassword = event => {
    event.preventDefault();
    run(async () => {
      if (form.newPassword !== form.confirmPassword) throw new Error('The new passwords do not match.');
      const result = await adminRequest('/api/admin/change-password', { body: { currentPassword: form.currentPassword, newPassword: form.newPassword } });
      onTokenChange(result.token, result.username);
      close();
      return `Password updated.${ended(result.endedSessions)}`;
    });
  };

  return (
    <article className="sec-card" id="sec-account" aria-labelledby="sec-account-heading">
      <header><FiUser aria-hidden="true" /><h4 id="sec-account-heading">Your account</h4></header>
      <Notice state={state} />
      <div className="sec-row">
        <div><span className="sec-row-label">Username</span><strong className="sec-row-value">{data.username}</strong>
          <small>Administrator since {formatDate(data.createdAt)}</small></div>
        {editing !== 'username' && <button type="button" className="btn btn-secondary" onClick={() => open('username')}>Change</button>}
      </div>
      {editing === 'username' && <form onSubmit={changeUsername} className="admin-form-stack sec-inline-form" aria-label="Change username">
        <label htmlFor="sec-new-username">New username<input id="sec-new-username" type="text" autoComplete="username" autoCapitalize="none" spellCheck={false} maxLength={64}
          className="search-input" value={form.newUsername} onChange={event => set('newUsername')(event.target.value)} aria-describedby="sec-new-username-help" autoFocus required /></label>
        <p id="sec-new-username-help" className="admin-help">3 to 64 characters: letters, digits, and . _ @ -. Every other session is signed out.</p>
        <PasswordField id="sec-username-password" label="Current password" value={form.currentPassword} onChange={set('currentPassword')} autoComplete="current-password" />
        <div className="admin-form-actions"><button type="submit" className="btn" disabled={state.busy}>{state.busy ? 'Saving…' : 'Update username'}</button>
          <button type="button" onClick={close} className="btn btn-secondary">Cancel</button></div>
      </form>}

      <div className="sec-row">
        <div><span className="sec-row-label">Password</span><strong className="sec-row-value">{data.passwordChangedAt ? `Changed ${timeAgo(data.passwordChangedAt, now)}` : `Set ${timeAgo(data.createdAt, now)}`}</strong>
          <small>At least 12 characters, not a common password</small></div>
        {editing !== 'password' && <button type="button" className="btn btn-secondary" onClick={() => open('password')}>Change</button>}
      </div>
      {editing === 'password' && <form onSubmit={changePassword} className="admin-form-stack sec-inline-form" aria-label="Change password">
        <PasswordField id="sec-current-password" label="Current password" value={form.currentPassword} onChange={set('currentPassword')} autoComplete="current-password" autoFocus />
        <PasswordField id="sec-new-password" label="New password" value={form.newPassword} onChange={set('newPassword')} autoComplete="new-password" describedBy="sec-new-password-strength" />
        <div id="sec-new-password-strength"><StrengthMeter password={form.newPassword} username={data.username} /></div>
        <PasswordField id="sec-confirm-password" label="Confirm new password" value={form.confirmPassword} onChange={set('confirmPassword')} autoComplete="new-password" />
        {form.confirmPassword && form.confirmPassword !== form.newPassword && <p className="sec-mismatch" role="status">The passwords do not match yet.</p>}
        <p className="admin-help">Saving signs out every other session.</p>
        <div className="admin-form-actions"><button type="submit" className="btn" disabled={state.busy || !passwordReady}>{state.busy ? 'Saving…' : 'Update password'}</button>
          <button type="button" onClick={close} className="btn btn-secondary">Cancel</button></div>
      </form>}
    </article>
  );
}

// ── Two-factor sign-in ──────────────────────────────────────────────────────
function RecoveryCodes({ codes, username, onDone }) {
  const [saved, setSaved] = useState(false);
  const [copied, setCopied] = useState(false);
  const copy = async () => { try { await navigator.clipboard.writeText(codes.join('\n')); setCopied(true); setTimeout(() => setCopied(false), 2000); } catch { /* clipboard blocked */ } };
  const download = () => {
    const url = URL.createObjectURL(new Blob([recoveryCodesFile(codes, username)], { type: 'text/plain' }));
    const link = Object.assign(document.createElement('a'), { href: url, download: 'laborlens-recovery-codes.txt' });
    link.click(); URL.revokeObjectURL(url);
  };
  return (
    <div className="sec-recovery">
      <p className="import-notice warning" role="status"><strong>Save these recovery codes now.</strong> Each one signs you in once if you lose your phone. They will not be shown again.</p>
      <ol className="sec-recovery-codes">{codes.map(code => <li key={code}><code>{code}</code></li>)}</ol>
      <div className="admin-form-actions">
        <button type="button" className="btn btn-secondary" onClick={copy}><FiCopy aria-hidden="true" />{copied ? 'Copied' : 'Copy'}</button>
        <button type="button" className="btn btn-secondary" onClick={download}><FiDownload aria-hidden="true" />Download</button>
      </div>
      <label className="sec-confirm"><input type="checkbox" checked={saved} onChange={event => setSaved(event.target.checked)} /> I saved these codes somewhere safe</label>
      <button type="button" className="btn" disabled={!saved} onClick={onDone}>Done</button>
    </div>
  );
}

function TwoFactorCard({ data, reload }) {
  const twoFactor = data.twoFactor;
  const [step, setStep] = useState('idle'); // idle | password | scan | codes | disable | regenerate
  const [setup, setSetup] = useState(null);
  const [codes, setCodes] = useState(null);
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [copied, setCopied] = useState(false);
  const [state, run, clear] = useAction();
  const go = next => { setStep(next); setPassword(''); setCode(''); clear(); };

  const begin = event => { event.preventDefault(); run(async () => { setSetup(await adminRequest('/api/admin/two-factor/setup', { body: { currentPassword: password } })); go('scan'); }); };
  const confirm = event => {
    event.preventDefault();
    run(async () => {
      try {
        const result = await adminRequest('/api/admin/two-factor/enable', { body: { code } });
        setCodes(result.recoveryCodes); setSetup(null); go('codes');
        await reload(); // the badge and checkup show it on while the codes stay up
      } catch (error) { if (error.data?.restart) go('password'); throw error; }
    });
  };
  const disable = event => { event.preventDefault(); run(async () => { await adminRequest('/api/admin/two-factor/disable', { body: { currentPassword: password, code } }); go('idle'); await reload(); return 'Two-factor sign-in is off.'; }); };
  const regenerate = event => { event.preventDefault(); run(async () => { const result = await adminRequest('/api/admin/two-factor/recovery-codes', { body: { currentPassword: password, code } }); setCodes(result.recoveryCodes); go('codes'); }); };
  const copySecret = async () => { try { await navigator.clipboard.writeText(setup.secret.replaceAll(' ', '')); setCopied(true); setTimeout(() => setCopied(false), 2000); } catch { /* clipboard blocked */ } };

  return (
    <article className="sec-card" id="sec-two-factor" aria-labelledby="sec-two-factor-heading">
      <header><FiSmartphone aria-hidden="true" /><h4 id="sec-two-factor-heading">Two-factor sign-in</h4>
        <span className={`sec-badge ${twoFactor.enabled ? 'is-ok' : 'is-warning'}`}>{twoFactor.enabled ? 'On' : 'Off'}</span></header>
      <Notice state={state} />

      {step === 'idle' && !twoFactor.enabled && <>
        <p className="admin-help">After your password, sign-in also asks for a six-digit code from an authenticator app such as 1Password, Google Authenticator, or Microsoft Authenticator. A stolen password alone is then not enough.</p>
        <button type="button" className="btn" onClick={() => go('password')}><FiShield aria-hidden="true" />Turn on two-factor sign-in</button>
      </>}
      {step === 'idle' && twoFactor.enabled && <>
        <dl className="sec-facts">
          <div><dt>On since</dt><dd>{formatDate(twoFactor.enabledAt)}</dd></div>
          <div><dt>Recovery codes left</dt><dd className={twoFactor.recoveryCodesLeft <= 3 ? 'is-warning' : ''}>{twoFactor.recoveryCodesLeft} of 10</dd></div>
        </dl>
        {twoFactor.recoveryCodesLeft <= 3 && <p className="import-notice warning">You are running out of recovery codes. Create a new set and keep it safe.</p>}
        <div className="admin-form-actions">
          <button type="button" className="btn btn-secondary" onClick={() => go('regenerate')}><FiRefreshCw aria-hidden="true" />New recovery codes</button>
          <button type="button" className="btn btn-secondary sec-danger" onClick={() => go('disable')}>Turn off</button>
        </div>
      </>}

      {step === 'password' && <form className="admin-form-stack sec-inline-form" onSubmit={begin} aria-label="Confirm your password">
        <p className="sec-step">Step 1 of 3 · Confirm it is you</p>
        <PasswordField id="sec-2fa-password" label="Current password" value={password} onChange={setPassword} autoComplete="current-password" autoFocus />
        <div className="admin-form-actions"><button type="submit" className="btn" disabled={state.busy}>{state.busy ? 'Checking…' : 'Continue'}</button>
          <button type="button" className="btn btn-secondary" onClick={() => go('idle')}>Cancel</button></div>
      </form>}

      {step === 'scan' && setup && <form className="admin-form-stack sec-inline-form" onSubmit={confirm} aria-label="Add LaborLens to your authenticator app">
        <p className="sec-step">Step 2 of 3 · Add LaborLens to your app</p>
        <div className="sec-scan">
          <img className="sec-qr" src={'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(setup.qrSvg)} width="176" height="176" alt="QR code to add LaborLens to an authenticator app" />
          <div>
            <p className="admin-help">Scan the code with your authenticator app. On this phone? <a href={setup.otpauthUrl}>Open it in your app</a>. Or type this key:</p>
            <p className="sec-secret"><code>{setup.secret}</code><button type="button" className="sec-icon-button" onClick={copySecret} aria-label="Copy key"><FiCopy aria-hidden="true" /></button>{copied && <span role="status">Copied</span>}</p>
            <p className="admin-help">This setup expires in {setup.expiresInMinutes} minutes.</p>
          </div>
        </div>
        <p className="sec-step">Step 3 of 3 · Enter the code it shows</p>
        <CodeField id="sec-2fa-code" value={code} onChange={setCode} />
        <p className="admin-help">Turning this on signs out every other session.</p>
        <div className="admin-form-actions"><button type="submit" className="btn" disabled={state.busy || code.replace(/\s/g, '').length !== 6}>{state.busy ? 'Checking…' : 'Turn on'}</button>
          <button type="button" className="btn btn-secondary" onClick={() => { setSetup(null); go('idle'); }}>Cancel</button></div>
      </form>}

      {step === 'codes' && codes && <RecoveryCodes codes={codes} username={data.username} onDone={async () => { setCodes(null); go('idle'); await reload(); }} />}

      {(step === 'disable' || step === 'regenerate') && <form className="admin-form-stack sec-inline-form" onSubmit={step === 'disable' ? disable : regenerate}
        aria-label={step === 'disable' ? 'Turn off two-factor sign-in' : 'Create new recovery codes'}>
        <p className="sec-step">{step === 'disable' ? 'Turning this off leaves only your password protecting the account.' : 'Your current recovery codes will stop working.'}</p>
        <PasswordField id="sec-2fa-confirm-password" label="Current password" value={password} onChange={setPassword} autoComplete="current-password" autoFocus />
        <CodeField id="sec-2fa-confirm-code" value={code} onChange={setCode} allowRecovery />
        <div className="admin-form-actions">
          <button type="submit" className={`btn${step === 'disable' ? ' sec-danger-solid' : ''}`} disabled={state.busy}>{state.busy ? 'Checking…' : step === 'disable' ? 'Turn off two-factor sign-in' : 'Create new codes'}</button>
          <button type="button" className="btn btn-secondary" onClick={() => go('idle')}>Cancel</button></div>
      </form>}
    </article>
  );
}

// ── Sessions ────────────────────────────────────────────────────────────────
function SessionsCard({ data, now, reload, onSignOut }) {
  const [state, run] = useAction();
  const [confirming, setConfirming] = useState(false);
  const others = data.sessions.filter(session => !session.current).length;
  const end = session => run(async () => {
    if (session.current) { onSignOut(); return; }
    await adminRequest('/api/admin/sessions/' + encodeURIComponent(session.id), { method: 'DELETE' });
    await reload();
    return `Signed out ${describeDevice(session.userAgent)}.`;
  });
  const endOthers = () => run(async () => {
    const result = await adminRequest('/api/admin/sessions/end-others', { body: {} });
    setConfirming(false); await reload();
    return `Signed out ${plural(result.ended, 'other session')}.`;
  });
  return (
    <article className="sec-card" id="sec-sessions" aria-labelledby="sec-sessions-heading">
      <header><FiMonitor aria-hidden="true" /><h4 id="sec-sessions-heading">Signed-in sessions</h4>
        {others > 0 && !confirming && <button type="button" className="btn btn-secondary" onClick={() => setConfirming(true)}><FiLogOut aria-hidden="true" />Sign out all others</button>}
      </header>
      {confirming && <div className="sec-confirm-bar" role="group" aria-label="Confirm signing out other sessions">
        <span>Sign out {plural(others, 'other session')}?</span>
        <button type="button" className="btn" onClick={endOthers} disabled={state.busy}>Sign out</button>
        <button type="button" className="btn btn-secondary" onClick={() => setConfirming(false)}>Cancel</button>
      </div>}
      <Notice state={state} />
      <ul className="sec-sessions">{data.sessions.map(session => {
        const Icon = isPhone(session.userAgent) ? FiSmartphone : FiMonitor;
        return <li key={session.id} className={session.current ? 'is-current' : ''}>
          <span className="sec-session-icon" aria-hidden="true"><Icon /></span>
          <div className="sec-session-main">
            <strong>{describeDevice(session.userAgent)}{session.current && <span className="sec-badge is-ok">This device</span>}</strong>
            <small>{session.ip || 'Unknown address'} · {session.twoFactor ? (session.twoFactor === 'recovery-code' ? 'Recovery code' : 'Password and code') : 'Password only'}</small>
            <small title={formatDateTime(session.createdAt)}>Signed in {timeAgo(session.createdAt, now)} · active {timeAgo(session.lastSeenAt, now)}</small>
          </div>
          <button type="button" className="btn btn-secondary" onClick={() => end(session)} disabled={state.busy}>{session.current ? 'Sign out' : 'End'}</button>
        </li>;
      })}</ul>
      <p className="admin-help">Sessions end after {data.policy.sessionHours} hours, or after {data.policy.idleHours} hours without use.</p>
    </article>
  );
}

// ── Lockouts ────────────────────────────────────────────────────────────────
function LockoutsCard({ data, reload }) {
  const [state, run] = useAction();
  const { addresses, accounts } = data.lockouts;
  const release = (path, label) => run(async () => { await adminRequest(path, { method: 'DELETE' }); await reload(); return `${label} can sign in again.`; });
  return (
    <article className="sec-card" id="sec-protection" aria-labelledby="sec-protection-heading">
      <header><FiShield aria-hidden="true" /><h4 id="sec-protection-heading">Sign-in protection</h4>
        <button type="button" className="sec-icon-button" onClick={() => run(reload)} aria-label="Refresh lockouts"><FiRefreshCw className={state.busy ? 'is-refreshing' : ''} aria-hidden="true" /></button></header>
      <p className="admin-help">Five failed sign-ins from one address, or ten for one account, within 15 minutes pause sign-in there for 15 minutes.</p>
      <Notice state={state} />
      {addresses.length + accounts.length === 0 ? <div className="sec-empty"><FiCheckCircle aria-hidden="true" /><span>Nothing is locked out right now.</span></div>
        : <ul className="sec-lockouts">
          {accounts.map(item => <li key={'a' + item.id}><span className="sec-lockout-kind">Account</span><strong>{item.username}</strong>
            <small>{item.attempts} failures · {waitText(item.secsLeft)} left</small>
            <button type="button" className="btn btn-secondary" onClick={() => release('/api/admin/lockouts/account/' + encodeURIComponent(item.id), item.username)}><FiUnlock aria-hidden="true" />Unlock</button></li>)}
          {addresses.map(item => <li key={'i' + item.ip}><span className="sec-lockout-kind">Address</span><strong><code>{item.ip}</code></strong>
            <small>{item.attempts} failures · {waitText(item.secsLeft)} left</small>
            <button type="button" className="btn btn-secondary" onClick={() => release('/api/admin/lockouts/address/' + encodeURIComponent(item.ip), item.ip)}><FiUnlock aria-hidden="true" />Unblock</button></li>)}
        </ul>}
    </article>
  );
}

// ── Sign-in history ─────────────────────────────────────────────────────────
// `now` changes whenever the tab reloads after an action, so the history picks up that action.
function HistoryCard({ now }) {
  const [query, setQuery] = useState({ filter: 'all', version: 0 });
  const [result, setResult] = useState({ events: null, error: '', loaded: null });
  const filter = query.filter;
  const busy = result.loaded !== query;
  useEffect(() => {
    let live = true;
    adminRequest('/api/admin/security-events' + (query.filter === 'failed' ? '?filter=failed' : ''))
      .then(events => live && setResult({ events, error: '', loaded: query }), error => live && setResult(current => ({ ...current, error: error.message, loaded: query })));
    return () => { live = false; };
  }, [query, now]);
  const events = result.events;
  const state = { busy, error: result.error };
  const setFilter = next => setQuery({ filter: next, version: 0 });
  const load = () => setQuery(current => ({ ...current, version: current.version + 1 }));
  return (
    <article className="sec-card sec-history" id="sec-history" aria-labelledby="sec-history-heading">
      <header><FiKey aria-hidden="true" /><h4 id="sec-history-heading">Sign-in history</h4>
        <div className="sec-segmented" role="group" aria-label="Show">
          {[['all', 'All'], ['failed', 'Failures']].map(([id, label]) => <button key={id} type="button" aria-pressed={filter === id} onClick={() => setFilter(id)}>{label}</button>)}
        </div>
        <button type="button" className="sec-icon-button" onClick={load} aria-label="Refresh history"><FiRefreshCw className={state.busy ? 'is-refreshing' : ''} aria-hidden="true" /></button>
      </header>
      {state.error && <p className="import-notice error" role="alert">{state.error}</p>}
      {events && events.length === 0 && <div className="sec-empty"><FiCheckCircle aria-hidden="true" /><span>{filter === 'failed' ? 'No failed attempts recorded.' : 'No sign-in activity yet.'}</span></div>}
      {events?.length > 0 && <ol className="sec-events">{events.map((event, index) => {
        const { label, tone, detail } = describeSecurityEvent(event);
        const Icon = LEVEL_ICON[tone];
        return <li key={index} className={'is-' + tone}><Icon aria-hidden="true" />
          <div><strong>{label}</strong><small>{[detail, event.ip, event.userAgent && describeDevice(event.userAgent)].filter(Boolean).join(' · ')}</small></div>
          <time dateTime={event.at} title={formatDateTime(event.at)}>{timeAgo(event.at, now)}</time></li>;
      })}</ol>}
      <p className="admin-help">Kept for 180 days. Passwords and codes are never recorded.</p>
    </article>
  );
}

export default function AccessSecurity({ onTokenChange, onSignOut }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [now, setNow] = useState(() => Date.now());
  const reload = useCallback(async () => {
    try { setData(await adminRequest('/api/admin/security')); setError(''); }
    catch (failure) { setError(failure.message); }
    setNow(Date.now());
  }, []);
  useEffect(() => {
    let live = true;
    adminRequest('/api/admin/security').then(result => { if (live) { setData(result); setNow(Date.now()); } }, failure => live && setError(failure.message));
    return () => { live = false; };
  }, []);

  if (!data) return error ? <p className="import-notice error" role="alert">{error}</p> : <p className="admin-empty" role="status">Loading security settings…</p>;
  return (
    <div className="sec">
      {error && <p className="import-notice error" role="alert">{error}</p>}
      <Checkup data={data} now={now} />
      <div className="sec-columns">
        <div className="sec-stack">
          <AccountCard data={data} now={now} onTokenChange={async (token, username) => { onTokenChange(token, username); await reload(); }} />
          <TwoFactorCard data={data} reload={reload} />
          <LockoutsCard data={data} reload={reload} />
        </div>
        <div className="sec-stack">
          <SessionsCard data={data} now={now} reload={reload} onSignOut={onSignOut} />
          <HistoryCard now={now} />
        </div>
      </div>
    </div>
  );
}
