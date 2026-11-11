import { useState, useRef, useEffect, useCallback } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { adminSection, adminSectionPath } from '../utils/navigation';
import AutomaticImports from './AutomaticImports';
import SiteDataStatus from './SiteDataStatus';
import AdminOverview from './AdminOverview';
import AccessSecurity, { CodeField } from './AccessSecurity';
import { adminRequest, SESSION_ENDED_EVENT } from '../utils/adminSecurity';
import './ImportView.css';
import { FiUploadCloud, FiLogOut, FiShield, FiRefreshCw, FiDatabase, FiGrid, FiArrowLeft } from 'react-icons/fi';


const ImportView = () => {
    const [isSigningIn, setIsSigningIn] = useState(false);
    const section = adminSection(useLocation().search);
    const navigate = useNavigate();
    const [isRefreshing, setIsRefreshing] = useState(false);
    const [uploadError, setUploadError] = useState('');
    const [uploadStatus, setUploadStatus] = useState('idle');
    const [file, setFile]                           = useState(null);
    const [isDragActive, setIsDragActive]           = useState(false);
    const [isUploading, setIsUploading]             = useState(false);
    const [isClearing, setIsClearing]               = useState(false);
    const [dataType, setDataType]                   = useState('pwd');
    const [logs, setLogs]                           = useState([]);
    const [progress, setProgress]                   = useState({ processed: 0, total: 0, percentage: 0, inserted: 0, updated: 0 });
    const [isAuthenticated, setIsAuthenticated]     = useState(false);
    const [isCheckingAuth, setIsCheckingAuth]       = useState(true);
    const [, setAdminUsername]                      = useState(() => (typeof localStorage === 'undefined' ? '' : localStorage.getItem('adminUsername') || ''));
    const [loginForm, setLoginForm]                 = useState({ username: '', password: '' });
    const [authError, setAuthError]                 = useState('');
    // Second sign-in step when two-factor sign-in is on: the server's short-lived challenge.
    const [challenge, setChallenge]                 = useState(null);
    const [loginCode, setLoginCode]                 = useState('');
    const [adminNotice, setAdminNotice]             = useState('');
    const [autoStatus, setAutoStatus]               = useState(null);
    const [autoStatusError, setAutoStatusError]     = useState('');

    const uploadRequestPending = useRef(false);
    const fileInputRef = useRef(null);
    const logsEndRef   = useRef(null);

    useEffect(() => {
        const checkAuth = async () => {
            const token = localStorage.getItem('adminToken');
            if (!token) { setIsCheckingAuth(false); return; }
            try {
                const res = await fetch('/api/admin/check-auth', { headers: { 'Authorization': `Bearer ${token}` } });
                if (res.ok) {
                    const data = await res.json().catch(() => ({}));
                    if (data.username) { localStorage.setItem('adminUsername', data.username); setAdminUsername(data.username); }
                    setIsAuthenticated(true);
                }
                else { localStorage.removeItem('adminToken'); localStorage.removeItem('adminUsername'); }
            } catch { localStorage.removeItem('adminToken'); }
            finally { setIsCheckingAuth(false); }
        };
        checkAuth();
    }, []);

    useEffect(() => {
        const consoleElement = logsEndRef.current?.parentElement;
        if (consoleElement) consoleElement.scrollTop = consoleElement.scrollHeight;
    }, [logs]);

    const handleDrag = (e) => {
        e.preventDefault(); e.stopPropagation();
        setIsDragActive(e.type === 'dragenter' || e.type === 'dragover');
    };

    const selectFile = (selected) => {
        if (!selected || isUploading || isClearing) return;
        if (!/\.xlsx$/i.test(selected.name)) { setFile(null); setUploadError('Choose a DOL disclosure workbook in .xlsx format.'); return; }
        if (selected.size > 768 * 1024 * 1024) { setFile(null); setUploadError('This file exceeds the 768 MB upload limit.'); return; }
        setUploadError('');
        setFile(selected);
    };

    const handleDrop = (e) => {
        e.preventDefault(); e.stopPropagation();
        setIsDragActive(false);
        selectFile(e.dataTransfer.files?.[0]);
    };

    const fetchStatus = async () => {
        if (uploadRequestPending.current) return;
        try {
            const res = await fetch('/api/upload/status', { headers: { Authorization: `Bearer ${localStorage.getItem('adminToken')}` } });
            if (!res.ok) return;
            const data = await res.json();
            setUploadStatus(data.status);
            if (data.status !== 'idle') {
                const pct = data.total > 0 ? Math.min(100, Math.round((data.processed / data.total) * 100)) : 0;
                setProgress({ processed: data.processed || 0, total: data.total || 0, percentage: data.status === 'done' ? 100 : pct, inserted: data.inserted || 0, updated: data.updated || 0 });
                if (data.logs?.length > 0) setLogs(data.logs);
                setIsUploading(data.status !== 'done' && data.status !== 'error');
            } else {
                setIsUploading(false);
            }
        } catch { /* ignore */ }
    };

    const onUpload = async () => {
        if (!file || isUploading || isClearing || autoStatus?.active) return;
        uploadRequestPending.current = true;
        setUploadStatus('starting');
        setIsUploading(true);
        setLogs(['Uploading file to server…']);
        setProgress({ processed: 0, total: 0, percentage: 0, inserted: 0, updated: 0 });
        const formData = new FormData();
        formData.append('file', file);
        formData.append('type', dataType);
        try {
            const res = await fetch('/api/upload', { method: 'POST', headers: { Authorization: `Bearer ${localStorage.getItem('adminToken')}` }, body: formData });
            if (!res.ok) { const err = await res.json(); throw new Error(err.error || 'Upload failed'); }
            uploadRequestPending.current = false;
            await fetchStatus();
        } catch (error) {
            setUploadStatus('error');
            setLogs(prev => [...prev, `Error: ${error.message}`]);
            setIsUploading(false);
        } finally {
            uploadRequestPending.current = false;
            setFile(null);
            if (fileInputRef.current) fileInputRef.current.value = '';
        }
    };

    const signedIn = data => {
        localStorage.setItem('adminToken', data.token); localStorage.setItem('adminUsername', data.username); setAdminUsername(data.username);
        setChallenge(null); setLoginCode(''); setLoginForm({ username: '', password: '' }); setIsAuthenticated(true);
        if (data.recoveryCodesLeft !== undefined) setAdminNotice(`You signed in with a recovery code. ${data.recoveryCodesLeft} left${data.recoveryCodesLeft <= 3 ? ': create new ones in Access & security' : ''}.`);
    };
    const handleLogin = async (e) => {
        e.preventDefault(); setAuthError('');
        setIsSigningIn(true);
        try {
            const data = await adminRequest('/api/admin/login', { body: loginForm });
            if (data.twoFactorRequired) { setChallenge(data.challenge); setLoginCode(''); }
            else signedIn(data);
        } catch (error) { setAuthError(error.status ? error.message : 'Network error. Please try again.'); }
        finally { setIsSigningIn(false); }
    };
    const handleTwoFactor = async (e) => {
        e.preventDefault(); setAuthError('');
        setIsSigningIn(true);
        try { signedIn(await adminRequest('/api/admin/login/two-factor', { body: { challenge, code: loginCode } })); }
        catch (error) {
            setAuthError(error.status ? error.message : 'Network error. Please try again.');
            if (error.data?.restart) { setChallenge(null); setLoginCode(''); setLoginForm(form => ({ ...form, password: '' })); }
        }
        finally { setIsSigningIn(false); }
    };

    // Clears this browser's sign-in. `message` explains why when the server ended the session.
    const clearSignIn = useCallback((message = '') => {
        localStorage.removeItem('adminToken'); localStorage.removeItem('adminUsername');
        setIsAuthenticated(false); setLoginForm({ username: '', password: '' }); setAdminUsername('');
        setChallenge(null); setLoginCode(''); setAdminNotice(''); setAuthError(message);
        setLogs([]); setProgress({ processed: 0, total: 0, percentage: 0, inserted: 0, updated: 0 });
        setAutoStatus(null);
        navigate(adminSectionPath('overview'), { replace: true });
        setFile(null);
        setUploadStatus('idle');
    }, [navigate]);
    // Signing out ends the session on the server too, so the token stops working everywhere.
    const handleLogout = async () => {
        try { await adminRequest('/api/admin/logout', { body: {} }); } catch { /* already ended or offline: clear locally anyway */ }
        clearSignIn();
    };
    useEffect(() => {
        const ended = () => clearSignIn('Your session has ended. Please sign in again.');
        window.addEventListener(SESSION_ENDED_EVENT, ended);
        return () => window.removeEventListener(SESSION_ENDED_EVENT, ended);
    }, [clearSignIn]);

    const fetchAutoStatus = useCallback(async () => {
        setIsRefreshing(true);
        try {
            const res = await fetch('/api/upload/auto/status', { headers: { Authorization: `Bearer ${localStorage.getItem('adminToken')}` } });
            if (!res.ok) throw new Error('Unable to load automatic import status.');
            setAutoStatus(await res.json());
            setAutoStatusError('');
        } catch (error) { setAutoStatusError(error.message); }
        finally { setIsRefreshing(false); }
    }, []);

    const onClearData = async () => {
        if (!window.confirm(`Delete ALL ${dataType.toUpperCase()} cases? This cannot be undone.`)) return;
        setIsClearing(true);
        setLogs(prev => [...prev, `Clearing all ${dataType.toUpperCase()} data…`]);
        try {
            const res  = await fetch(`/api/cases?type=${dataType}`, { method: 'DELETE', headers: { Authorization: `Bearer ${localStorage.getItem('adminToken')}` } });
            const data = await res.json();
            if (res.ok) setLogs(prev => [...prev, `✅ Cleared ${data.deletedCount} records.`]);
            else throw new Error(data.error || 'Failed to clear data');
        } catch (error) {
            setLogs(prev => [...prev, `❌ Error: ${error.message}`]);
        } finally { setIsClearing(false); }
    };

    useEffect(() => {
        if (isAuthenticated) fetchStatus();
    }, [isAuthenticated]);

    useEffect(() => {
        if (!isAuthenticated || !isUploading) return;
        const interval = setInterval(fetchStatus, 1500);
        return () => clearInterval(interval);
    }, [isUploading, isAuthenticated]);

    useEffect(() => {
        if (!isAuthenticated) return;
        fetchAutoStatus();
        const iv = setInterval(fetchAutoStatus, 15000);
        return () => clearInterval(iv);
    }, [isAuthenticated, fetchAutoStatus]);

    if (isCheckingAuth) {
        return <div className="loading-overlay" role="status"><div className="spinner-large" /><p>Checking authentication…</p></div>;
    }

    if (!isAuthenticated) {
        return <div className="admin-login">
            <section className="admin-login-intro" aria-labelledby="admin-login-heading">
                <span className="admin-login-mark" aria-hidden="true"><FiDatabase /></span>
                <p className="section-kicker">LaborLens administration</p>
                <h2 id="admin-login-heading">Data management</h2>
                <p>Monitor DOL imports, inspect validation reports, and manage the disclosure archive.</p>
                <dl className="admin-login-guide">
                    <div><dt>Monitor imports</dt><dd>Live progress for H-1B, PWD, and PERM releases.</dd></div>
                    <div><dt>Review source quality</dt><dd>Inspect validation details and original source values.</dd></div>
                    <div><dt>Manage datasets</dt><dd>Upload a specific release and manage administrator access.</dd></div>
                </dl>
            </section>
            <section className="admin-login-form" aria-labelledby="admin-sign-in-heading">
                <FiShield aria-hidden="true" className="admin-form-icon" />
                <h3 id="admin-sign-in-heading">{challenge ? 'Two-factor sign-in' : 'Administrator sign-in'}</h3>
                <p className="admin-help">{challenge ? 'Enter the six-digit code from your authenticator app.' : 'Use your LaborLens administrator account.'}</p>
                {authError && <p className="import-notice error" role="alert">{authError}</p>}
                {!challenge && <form onSubmit={handleLogin} className="admin-form-stack">
                    <label htmlFor="admin-username">Username<input id="admin-username" type="text" autoComplete="username" autoCapitalize="none" spellCheck={false} className="search-input" value={loginForm.username} onChange={event => setLoginForm({ ...loginForm, username: event.target.value })} required /></label>
                    <label htmlFor="admin-password">Password<input id="admin-password" type="password" autoComplete="current-password" className="search-input" value={loginForm.password} onChange={event => setLoginForm({ ...loginForm, password: event.target.value })} required /></label>
                    <button type="submit" className="btn" disabled={isSigningIn}>{isSigningIn ? 'Signing in…' : 'Sign in'}</button>
                </form>}
                {challenge && <form onSubmit={handleTwoFactor} className="admin-form-stack">
                    <CodeField id="admin-login-code" value={loginCode} onChange={setLoginCode} allowRecovery autoFocus />
                    <button type="submit" className="btn" disabled={isSigningIn || !loginCode.trim()}>{isSigningIn ? 'Checking…' : 'Verify'}</button>
                    <button type="button" className="btn btn-secondary" onClick={() => { setChallenge(null); setLoginCode(''); setAuthError(''); setLoginForm(form => ({ ...form, password: '' })); }}>
                        <FiArrowLeft aria-hidden="true" /> Back</button>
                </form>}
            </section>
        </div>;
    }

    return <div className="import-container admin-page">
        <header className="admin-page-heading">
            <div><p className="section-kicker">Administration</p><h2>Data management</h2><p>Monitor the site’s data, background jobs, backups and access.</p></div>
            <button onClick={handleLogout} className="btn btn-secondary admin-sign-out"><FiLogOut aria-hidden="true" /> Sign out</button>
        </header>
        {adminNotice && <p className="import-notice warning" role="status">{adminNotice} <button type="button" className="sec-text-button" onClick={() => setAdminNotice('')}>Dismiss</button></p>}
        <nav className="admin-sections" aria-label="Administration sections">
            {[['overview', 'Overview', <FiGrid aria-hidden="true" />], ['automatic', 'Automatic imports', <FiRefreshCw aria-hidden="true" />], ['data', 'Site data', <FiDatabase aria-hidden="true" />], ['manual', 'Manual upload', <FiUploadCloud aria-hidden="true" />], ['security', 'Access & security', <FiShield aria-hidden="true" />]].map(([id, label, icon]) => <Link key={id} to={adminSectionPath(id)} aria-current={section === id ? 'page' : undefined}>{icon}<span>{label}</span></Link>)}
        </nav>

        {section === 'overview' && <AdminOverview />}
        {section === 'data' && <SiteDataStatus />}
        {section === 'automatic' && <AutomaticImports status={autoStatus} error={autoStatusError} refreshing={isRefreshing} onRefresh={fetchAutoStatus} />}

        <section aria-labelledby="manual-upload-heading" hidden={section !== 'manual'}>
            <div className="admin-section-heading"><div><p className="section-kicker">Dataset maintenance</p><h3 id="manual-upload-heading">Manual upload</h3><p className="admin-help">Import a specific DOL release or recover a missing dataset.</p></div></div>
            <div className="admin-manual-layout">
                <aside className="admin-upload-guide" aria-label="Upload guidance">
                    <h4>Before you upload</h4>
                    <ol><li>Choose the program that matches your workbook.</li><li>Select an original DOL .xlsx disclosure file, up to 768 MB.</li><li>Start the import and follow its validation and processing log.</li></ol>
                    <p className="admin-help">Every row is validated before import. Existing case numbers are updated.</p>
                    {autoStatus?.active && <p role="status" className="import-notice warning">{autoStatus.active.label} is running. Wait for it to finish before starting a manual import.</p>}
                    <details className="import-danger-zone"><summary>Delete dataset records</summary><p>This removes all {dataType === 'h1b' ? 'H-1B' : dataType.toUpperCase()} cases. This cannot be undone.</p><button className="btn btn-danger" onClick={onClearData} disabled={isUploading || isClearing || Boolean(autoStatus?.active)}>{isClearing ? 'Deleting…' : `Delete all ${dataType.toUpperCase()} records`}</button></details>
                </aside>
                <div className="manual-upload-form">
                    <fieldset className="import-program-selector" disabled={isUploading || isClearing}><legend>Dataset program</legend>
                        {['pwd', 'perm', 'h1b'].map(type => <label key={type}><input type="radio" name="dataType" value={type} checked={dataType === type} onChange={event => setDataType(event.target.value)} /><span>{type === 'h1b' ? 'H-1B' : type.toUpperCase()}</span></label>)}
                    </fieldset>
                    <button type="button" disabled={isUploading || isClearing} className={`drop-zone ${isDragActive ? 'active' : ''}`} onDragEnter={handleDrag} onDragLeave={handleDrag} onDragOver={handleDrag} onDrop={handleDrop} onClick={() => fileInputRef.current?.click()}>
                        <FiUploadCloud className="upload-icon" aria-hidden="true" />
                        {file ? <span className="upload-file"><strong>{file.name}</strong><span>{(file.size / 1024 / 1024).toFixed(2)} MB · select to replace</span></span> : <span className="upload-file"><strong>Drop your .xlsx workbook here</strong><span>or select to browse your files</span></span>}
                    </button>
                    {uploadError && <p className="import-notice error" role="alert">{uploadError}</p>}
                    <input type="file" accept=".xlsx" aria-label="DOL disclosure workbook" className="sr-only" tabIndex={-1} disabled={isUploading || isClearing} ref={fileInputRef} onChange={event => selectFile(event.target.files?.[0])} />
                    <div className="admin-upload-actions"><span className="admin-help">{file ? 'Workbook selected. Ready to import.' : 'Select a workbook to continue.'}</span><button className="btn" onClick={onUpload} disabled={!file || isUploading || isClearing || Boolean(autoStatus?.active)}>{isUploading ? 'Processing…' : `Import ${dataType === 'h1b' ? 'H-1B' : dataType.toUpperCase()} workbook`}</button></div>
                    {(isUploading || uploadStatus === 'error' || progress.percentage > 0) && <section className={`admin-upload-progress ${uploadStatus}`} aria-label="Manual import status">
                        <div className="admin-upload-progress-heading"><strong>{uploadStatus === 'error' ? 'Import failed — see details below' : uploadStatus === 'done' ? 'Import complete' : 'Processing…'}</strong>{progress.total > 0 && <span>{progress.percentage}%</span>}</div>
                        <div className="coverage-meter" role="progressbar" aria-label="Manual import progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress.percentage}><span style={{ width: `${progress.percentage}%` }} /></div>
                        <dl className="admin-upload-counts"><div><dt>Cases processed</dt><dd>{progress.processed.toLocaleString()}{progress.total > 0 ? ` / ${progress.total.toLocaleString()}` : ''}</dd></div><div><dt>Inserted</dt><dd>{progress.inserted.toLocaleString()}</dd></div><div><dt>Updated</dt><dd>{progress.updated.toLocaleString()}</dd></div></dl>
                    </section>}
                    {(logs.length > 0 || isUploading) && <div className="progress-console" tabIndex={0} aria-label="Import activity log">{logs.map((log, index) => <div key={index}>{log}</div>)}{isUploading && progress.percentage < 100 && <span aria-hidden="true">_</span>}<div ref={logsEndRef} /></div>}
                </div>
            </div>
        </section>

        {section === 'security' && <section aria-labelledby="access-security-heading">
            <div className="admin-section-heading"><div><p className="section-kicker">Administrator controls</p><h3 id="access-security-heading">Access & security</h3><p className="admin-help">Your account, two-factor sign-in, signed-in sessions and sign-in history.</p></div></div>
            <AccessSecurity onSignOut={handleLogout}
                onTokenChange={(token, username) => { localStorage.setItem('adminToken', token); localStorage.setItem('adminUsername', username); setAdminUsername(username); }} />
        </section>}
    </div>;
};

export default ImportView;
