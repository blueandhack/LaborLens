import { useState, useRef, useEffect, useCallback } from 'react';
import AutomaticImports from './AutomaticImports';
import SiteDataStatus from './SiteDataStatus';
import './ImportView.css';
import { FiUploadCloud, FiLogOut, FiSettings, FiX, FiShield, FiUnlock, FiRefreshCw, FiDatabase } from 'react-icons/fi';

const ImportView = () => {
    const [isSigningIn, setIsSigningIn] = useState(false);
    const [isCheckingIPs, setIsCheckingIPs] = useState(false);
    const [blockedIPsError, setBlockedIPsError] = useState('');
    const [section, setSection] = useState('automatic');
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
    const [showChangePassword, setShowChangePassword] = useState(false);
    const [loginForm, setLoginForm]                 = useState({ username: '', password: '' });
    const [passwordForm, setPasswordForm]           = useState({ currentPassword: '', newPassword: '', confirmPassword: '' });
    const [authError, setAuthError]                 = useState('');
    const [pwdMessage, setPwdMessage]               = useState({ type: '', text: '' });
    const [blockedIPs, setBlockedIPs]               = useState([]);
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
                if (res.ok) setIsAuthenticated(true);
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

    const handleLogin = async (e) => {
        e.preventDefault(); setAuthError('');
        setIsSigningIn(true);
        try {
            const res  = await fetch('/api/admin/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(loginForm) });
            const data = await res.json();
            if (res.ok) { localStorage.setItem('adminToken', data.token); localStorage.setItem('adminUsername', data.username); setIsAuthenticated(true); }
            else setAuthError(data.error || 'Login failed');
        } catch { setAuthError('Network error. Please try again.'); }
        finally { setIsSigningIn(false); }
    };

    const handleLogout = () => {
        localStorage.removeItem('adminToken'); localStorage.removeItem('adminUsername');
        setIsAuthenticated(false); setLoginForm({ username: '', password: '' });
        setLogs([]); setProgress({ processed: 0, total: 0, percentage: 0, inserted: 0, updated: 0 });
        setBlockedIPs([]);
        setAutoStatus(null);
        setSection('automatic');
        setFile(null);
        setUploadStatus('idle');
        setShowChangePassword(false);
        setPasswordForm({ currentPassword: '', newPassword: '', confirmPassword: '' });
        setBlockedIPsError('');
    };

    const fetchBlockedIPs = useCallback(async () => {
        setIsCheckingIPs(true);
        try {
            const token = localStorage.getItem('adminToken');
            const res = await fetch('/api/admin/blocked-ips', { headers: { 'Authorization': `Bearer ${token}` } });
            if (!res.ok) throw new Error('Unable to load blocked addresses. Refresh to try again.');
            setBlockedIPs(await res.json());
            setBlockedIPsError('');
        } catch { setBlockedIPsError('Unable to load blocked addresses. Refresh to try again.'); }
        finally { setIsCheckingIPs(false); }
    }, []);

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

    const handleUnblock = async (ip) => {
        try {
            const token = localStorage.getItem('adminToken');
            await fetch(`/api/admin/blocked-ips/${encodeURIComponent(ip)}`, { method: 'DELETE', headers: { 'Authorization': `Bearer ${token}` } });
            fetchBlockedIPs();
        } catch { /* ignore */ }
    };

    const handleChangePassword = async (e) => {
        e.preventDefault(); setPwdMessage({ type: '', text: '' });
        if (passwordForm.newPassword !== passwordForm.confirmPassword) { setPwdMessage({ type: 'error', text: 'New passwords do not match' }); return; }
        try {
            const token = localStorage.getItem('adminToken');
            const res   = await fetch('/api/admin/change-password', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` }, body: JSON.stringify({ currentPassword: passwordForm.currentPassword, newPassword: passwordForm.newPassword }) });
            const data  = await res.json();
            if (res.ok) {
                setPwdMessage({ type: 'success', text: 'Password updated successfully' });
                setTimeout(() => { setShowChangePassword(false); setPasswordForm({ currentPassword: '', newPassword: '', confirmPassword: '' }); setPwdMessage({ type: '', text: '' }); }, 2000);
            } else setPwdMessage({ type: 'error', text: data.error || 'Failed to update password' });
        } catch { setPwdMessage({ type: 'error', text: 'Network error. Please try again.' }); }
    };

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
        fetchBlockedIPs();
        const iv = setInterval(fetchBlockedIPs, 30000);
        return () => clearInterval(iv);
    }, [isAuthenticated, fetchBlockedIPs]);

    useEffect(() => {
        if (!isAuthenticated) return;
        fetchAutoStatus();
        const iv = setInterval(fetchAutoStatus, 15000);
        return () => clearInterval(iv);
    }, [isAuthenticated, fetchAutoStatus]);

    const closePasswordForm = () => {
        setShowChangePassword(false);
        setPasswordForm({ currentPassword: '', newPassword: '', confirmPassword: '' });
        setPwdMessage({ type: '', text: '' });
        requestAnimationFrame(() => document.getElementById('admin-change-password-toggle')?.focus());
    };

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
                <h3 id="admin-sign-in-heading">Administrator sign-in</h3>
                <p className="admin-help">Use your LaborLens administrator account.</p>
                {authError && <p className="import-notice error" role="alert">{authError}</p>}
                <form onSubmit={handleLogin} className="admin-form-stack">
                    <label htmlFor="admin-username">Username<input id="admin-username" type="text" autoComplete="username" className="search-input" value={loginForm.username} onChange={event => setLoginForm({ ...loginForm, username: event.target.value })} required /></label>
                    <label htmlFor="admin-password">Password<input id="admin-password" type="password" autoComplete="current-password" className="search-input" value={loginForm.password} onChange={event => setLoginForm({ ...loginForm, password: event.target.value })} required /></label>
                    <button type="submit" className="btn" disabled={isSigningIn}>{isSigningIn ? 'Signing in…' : 'Sign in'}</button>
                </form>
            </section>
        </div>;
    }

    return <div className="import-container admin-page">
        <header className="admin-page-heading">
            <div><p className="section-kicker">Administration</p><h2>Data management</h2><p>Monitor DOL imports and inspect the quality of your datasets.</p></div>
            <button onClick={handleLogout} className="btn btn-secondary admin-sign-out"><FiLogOut aria-hidden="true" /> Sign out</button>
        </header>
        <nav className="admin-sections" aria-label="Administration sections">
            {[['automatic', 'Automatic imports', <FiRefreshCw aria-hidden="true" />], ['data', 'Site data', <FiDatabase aria-hidden="true" />], ['manual', 'Manual upload', <FiUploadCloud aria-hidden="true" />], ['security', 'Access & security', <FiShield aria-hidden="true" />]].map(([id, label, icon]) => <button key={id} aria-pressed={section === id} onClick={() => setSection(id)}>{icon}<span>{label}</span></button>)}
        </nav>

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

        <section aria-labelledby="access-security-heading" hidden={section !== 'security'}>
            <div className="admin-section-heading"><div><p className="section-kicker">Administrator controls</p><h3 id="access-security-heading">Access & security</h3><p className="admin-help">Manage your password and review blocked sign-in attempts.</p></div></div>
            <div className="admin-security-layout">
                <section className="admin-account-panel" aria-labelledby="admin-account-heading">
                    <FiSettings className="admin-form-icon" aria-hidden="true" /><h4 id="admin-account-heading">Your administrator account</h4><p className="admin-help">Update the password used to access data management.</p>
                    {!showChangePassword && <button id="admin-change-password-toggle" onClick={() => { setShowChangePassword(true); requestAnimationFrame(() => document.getElementById('admin-current-password')?.focus()); }} className="btn btn-secondary" aria-expanded={false}>Change password</button>}
                    {showChangePassword && <form onSubmit={handleChangePassword} className="admin-form-stack">
                        {pwdMessage.text && <p className={`import-notice ${pwdMessage.type}`} role={pwdMessage.type === 'error' ? 'alert' : 'status'}>{pwdMessage.text}</p>}
                        <label htmlFor="admin-current-password">Current password<input id="admin-current-password" type="password" autoComplete="current-password" className="search-input" value={passwordForm.currentPassword} onChange={event => setPasswordForm({ ...passwordForm, currentPassword: event.target.value })} required /></label>
                        <label htmlFor="admin-new-password">New password<input id="admin-new-password" type="password" autoComplete="new-password" className="search-input" value={passwordForm.newPassword} onChange={event => setPasswordForm({ ...passwordForm, newPassword: event.target.value })} required /></label>
                        <label htmlFor="admin-confirm-password">Confirm new password<input id="admin-confirm-password" type="password" autoComplete="new-password" className="search-input" value={passwordForm.confirmPassword} onChange={event => setPasswordForm({ ...passwordForm, confirmPassword: event.target.value })} required /></label>
                        <div className="admin-form-actions"><button type="submit" className="btn">Update password</button><button type="button" onClick={closePasswordForm} className="btn btn-secondary"><FiX aria-hidden="true" /> Cancel</button></div>
                    </form>}
                </section>
                <section className="admin-blocked-panel" aria-labelledby="blocked-addresses-heading">
                    <div className="admin-section-heading"><div><h4 id="blocked-addresses-heading">Blocked addresses</h4><p className="admin-help">Addresses temporarily blocked after repeated failed sign-ins.</p></div><button onClick={fetchBlockedIPs} className="btn btn-secondary" disabled={isCheckingIPs}><FiRefreshCw className={isCheckingIPs ? 'is-refreshing' : ''} aria-hidden="true" />{isCheckingIPs ? 'Refreshing…' : 'Refresh addresses'}</button></div>
                    {blockedIPsError && <p className="import-notice error" role="alert">{blockedIPsError}</p>}
                    {isCheckingIPs && blockedIPs.length === 0 ? <p className="admin-empty" role="status">Checking blocked addresses…</p> : !blockedIPsError && blockedIPs.length === 0 ? <div className="admin-empty admin-security-empty"><FiShield aria-hidden="true" /><h4>No blocked addresses</h4><p>No sign-in addresses are currently blocked.</p></div> : null}
                    {blockedIPs.length > 0 && <ul className="admin-blocked-list">{blockedIPs.map(({ ip, attempts, secsLeft }) => <li key={ip}>
                        <code className="admin-blocked-ip">{ip}</code><dl><div><dt>Attempts</dt><dd>{attempts}</dd></div><div><dt>Time remaining</dt><dd>{Math.floor(secsLeft / 60) > 0 ? `${Math.floor(secsLeft / 60)}m ` : ''}{secsLeft % 60}s</dd></div></dl><button onClick={() => handleUnblock(ip)} className="btn btn-secondary"><FiUnlock aria-hidden="true" /> Unblock</button>
                    </li>)}</ul>}
                </section>
            </div>
        </section>
    </div>;
};

export default ImportView;
