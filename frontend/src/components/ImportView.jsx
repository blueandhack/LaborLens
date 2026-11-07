import React, { useState, useRef, useEffect, useCallback } from 'react';
import AutomaticImports from './AutomaticImports';
import './ImportView.css';
import { FiUploadCloud, FiLogOut, FiSettings, FiX, FiShield, FiUnlock } from 'react-icons/fi';

const ImportView = () => {
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

    useEffect(() => { logsEndRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [logs]);

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
        try {
            const res  = await fetch('/api/admin/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(loginForm) });
            const data = await res.json();
            if (res.ok) { localStorage.setItem('adminToken', data.token); localStorage.setItem('adminUsername', data.username); setIsAuthenticated(true); }
            else setAuthError(data.error || 'Login failed');
        } catch { setAuthError('Network error. Please try again.'); }
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
    };

    const fetchBlockedIPs = useCallback(async () => {
        try {
            const token = localStorage.getItem('adminToken');
            const res = await fetch('/api/admin/blocked-ips', { headers: { 'Authorization': `Bearer ${token}` } });
            if (res.ok) setBlockedIPs(await res.json());
        } catch { /* ignore */ }
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

    if (isCheckingAuth) {
        return <div className="loading-overlay"><div className="spinner-large" /><p>Checking authentication…</p></div>;
    }

    if (!isAuthenticated) {
        return (
            <div className="admin-login">
                <p className="section-kicker">Administration</p>
                <h2 style={{ marginBottom: '6px', fontSize: '20px', fontWeight: 700 }}>Data management</h2>
                <p style={{ color: 'var(--text-secondary)', fontSize: '13px', marginBottom: '24px' }}>
                    Sign in to monitor imports, review validation reports, and manage datasets.
                </p>
                {authError && (
                    <div style={{ color: 'var(--status-denied)', marginBottom: '16px', padding: '10px 14px', background: 'rgba(181,83,58,0.1)', borderRadius: '6px', fontSize: '13px', border: '1px solid rgba(181,83,58,0.2)' }}>
                        {authError}
                    </div>
                )}
                <form onSubmit={handleLogin} style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
                    <input type="text" aria-label="Username" autoComplete="username" placeholder="Username" className="search-input"
                        value={loginForm.username} onChange={e => setLoginForm({ ...loginForm, username: e.target.value })} required style={{ width: '100%' }} />
                    <input type="password" aria-label="Password" autoComplete="current-password" placeholder="Password" className="search-input"
                        value={loginForm.password} onChange={e => setLoginForm({ ...loginForm, password: e.target.value })} required style={{ width: '100%' }} />
                    <button type="submit" className="btn" style={{ width: '100%', justifyContent: 'center', marginTop: '4px' }}>
                        Sign In
                    </button>
                </form>
            </div>
        );
    }

    return (
        <div className="import-container admin-page">
            <div className="admin-page-heading">
                <div><p className="section-kicker">Administration</p><h2>Data management</h2><p>Monitor DOL imports and inspect the quality of your datasets.</p></div>
                <button onClick={handleLogout} className="btn btn-secondary"><FiLogOut /> Sign out</button>
            </div>
            <nav className="admin-sections" aria-label="Administration sections">
                {[['automatic', 'Automatic imports'], ['manual', 'Manual upload'], ['security', 'Access & security']].map(([id, label]) => <button key={id} aria-pressed={section === id} onClick={() => setSection(id)}>{label}</button>)}
            </nav>

            {/* Change password modal */}
            {showChangePassword && (
                <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', backdropFilter: 'blur(6px)', zIndex: 1000, display: 'flex', justifyContent: 'center', alignItems: 'center', padding: '16px' }}>
                    <div className="glass-panel" style={{ width: '100%', maxWidth: '380px', padding: '28px', position: 'relative' }}>
                        <button onClick={() => { setShowChangePassword(false); setPasswordForm({ currentPassword: '', newPassword: '', confirmPassword: '' }); setPwdMessage({ type: '', text: '' }); }}
                            style={{ position: 'absolute', top: 16, right: 16, background: 'none', border: 'none', color: 'var(--text-secondary)', cursor: 'pointer', fontSize: 20, display: 'flex' }}>
                            <FiX />
                        </button>
                        <h2 style={{ marginBottom: '20px', fontSize: '17px', fontWeight: 600 }}>Change Password</h2>
                        {pwdMessage.text && (
                            <div style={{ color: pwdMessage.type === 'error' ? 'var(--status-denied)' : 'var(--status-certified)', marginBottom: '14px', padding: '10px 14px', background: pwdMessage.type === 'error' ? 'rgba(181,83,58,0.1)' : 'rgba(78,140,92,0.1)', borderRadius: '6px', fontSize: '13px' }}>
                                {pwdMessage.text}
                            </div>
                        )}
                        <form onSubmit={handleChangePassword} style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
                            <input type="password" placeholder="Current Password" className="search-input" value={passwordForm.currentPassword} onChange={e => setPasswordForm({ ...passwordForm, currentPassword: e.target.value })} required style={{ width: '100%' }} />
                            <input type="password" placeholder="New Password" className="search-input" value={passwordForm.newPassword} onChange={e => setPasswordForm({ ...passwordForm, newPassword: e.target.value })} required style={{ width: '100%' }} />
                            <input type="password" placeholder="Confirm New Password" className="search-input" value={passwordForm.confirmPassword} onChange={e => setPasswordForm({ ...passwordForm, confirmPassword: e.target.value })} required style={{ width: '100%' }} />
                            <button type="submit" className="btn" style={{ width: '100%', justifyContent: 'center', marginTop: '6px' }}>
                                Update Password
                            </button>
                        </form>
                    </div>
                </div>
            )}

            {section === 'automatic' && <AutomaticImports status={autoStatus} error={autoStatusError} refreshing={isRefreshing} onRefresh={fetchAutoStatus} />}
            <section aria-labelledby="manual-upload-heading" hidden={section !== 'manual'}>
                <div className="admin-section-heading"><div><h3 id="manual-upload-heading">Manual upload</h3><p className="admin-help">Use a manual upload for a specific DOL release or to recover a missing dataset.</p></div></div>
                <p className="import-notice">Choose the matching program and an original DOL .xlsx workbook (up to 768 MB). Every row is validated before import; existing case numbers are updated.</p>
                {autoStatus?.active && <p role="status" className="import-notice warning">{autoStatus.active.label} is running. Wait for it to finish before starting a manual import.</p>}
                <div className="manual-upload-form">
                <fieldset className="import-program-selector" disabled={isUploading || isClearing}><legend>Dataset program</legend>
                    {['pwd', 'perm', 'h1b'].map(type => <label key={type}><input type="radio" name="dataType" value={type} checked={dataType === type} onChange={event => setDataType(event.target.value)} />{type === 'h1b' ? 'H-1B' : type.toUpperCase()}</label>)}
                </fieldset>
            {/* Drop zone */}
            <button type="button" disabled={isUploading || isClearing} className={`drop-zone ${isDragActive ? 'active' : ''}`}
                onDragEnter={handleDrag} onDragLeave={handleDrag} onDragOver={handleDrag} onDrop={handleDrop}
                onClick={() => fileInputRef.current?.click()}>
                <FiUploadCloud className="upload-icon" />
                {file ? (
                    <span className="upload-file"><strong>{file.name}</strong><span>{(file.size / 1024 / 1024).toFixed(2)} MB</span></span>
                ) : (
                    <span className="upload-file"><strong>Drop your <span className="mono">.xlsx</span> file here</strong><span>or click to browse</span></span>
                )}
            </button>
            {uploadError && <p className="import-notice error" role="alert">{uploadError}</p>}

            <input type="file" accept=".xlsx" style={{ display: 'none' }} ref={fileInputRef} onChange={e => selectFile(e.target.files?.[0])} />

            {/* Action buttons */}
            <div style={{ marginTop: '20px', display: 'flex', gap: '10px', justifyContent: 'center', flexWrap: 'wrap' }}>
                <button className="btn" onClick={onUpload} disabled={!file || isUploading || isClearing || Boolean(autoStatus?.active)}>
                    {isUploading ? 'Processing…' : `Import ${dataType === 'h1b' ? 'H-1B' : dataType.toUpperCase()} workbook`}
                </button>
            </div>

            {/* Progress bar */}
            {(isUploading || uploadStatus === 'error' || progress.percentage > 0) && (
                <div style={{ marginTop: '24px', background: 'var(--surface)', padding: '18px 20px', borderRadius: '10px', border: '1px solid var(--border-color)', textAlign: 'left' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '10px', fontSize: '13px' }}>
                        <span style={{ fontWeight: 600, color: uploadStatus === 'error' ? 'var(--status-denied)' : uploadStatus === 'done' ? 'var(--status-certified)' : 'var(--accent-primary)' }}>
                            {uploadStatus === 'error' ? 'Import failed — see details below' : uploadStatus === 'done' ? 'Import complete' : 'Processing…'}
                        </span>
                        {progress.total > 0 && <span style={{ fontWeight: 600, color: 'var(--text-primary)' }}>{progress.percentage}%</span>}
                    </div>
                    <div role="progressbar" aria-label="Manual import progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress.percentage} style={{ width: '100%', height: '6px', background: 'var(--progress-track)', borderRadius: '3px', overflow: 'hidden' }}>
                        <div style={{ width: `${progress.percentage}%`, height: '100%', background: uploadStatus === 'error' ? 'var(--status-denied)' : uploadStatus === 'done' ? 'var(--status-certified)' : 'var(--accent-primary)', borderRadius: '3px', transition: 'width 0.3s ease' }} />
                    </div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: '10px', fontSize: '12px', color: 'var(--text-secondary)' }}>
                        <span>{progress.processed.toLocaleString()}{progress.total > 0 ? ` / ${progress.total.toLocaleString()}` : ''} cases</span>
                        <span>{progress.inserted.toLocaleString()} inserted · {progress.updated.toLocaleString()} updated</span>
                    </div>
                </div>
            )}

            {/* Console log */}
            {(logs.length > 0 || isUploading) && (
                <div className="progress-console">
                    {logs.map((log, i) => <div key={i}>{log}</div>)}
                    {isUploading && progress.percentage < 100 && (
                        <span style={{ animation: 'blink 1s step-end infinite' }}>_</span>
                    )}
                    <div ref={logsEndRef} />
                </div>
            )}

                </div>
                <details className="import-danger-zone"><summary>Delete dataset records</summary><p>This removes all {dataType === 'h1b' ? 'H-1B' : dataType.toUpperCase()} cases. This cannot be undone.</p><button className="btn btn-danger" onClick={onClearData} disabled={isUploading || isClearing || Boolean(autoStatus?.active)}>{isClearing ? 'Deleting…' : `Delete all ${dataType.toUpperCase()} records`}</button></details>
            </section>
            <section aria-labelledby="access-security-heading" hidden={section !== 'security'}>
                <div className="admin-section-heading"><div><h3 id="access-security-heading">Access & security</h3><p className="admin-help">Manage your administrator password and blocked sign-in attempts.</p></div><button onClick={() => setShowChangePassword(true)} className="btn btn-secondary"><FiSettings /> Change password</button></div>
            {/* Blocked IPs */}
            <div style={{ marginTop: '32px', borderTop: '1px solid var(--border-color)', paddingTop: '24px' }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '14px' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '15px', fontWeight: 600 }}>
                        <FiShield size={15} style={{ color: blockedIPs.length > 0 ? 'var(--status-denied)' : 'var(--text-secondary)' }} />
                        Blocked IPs
                        {blockedIPs.length > 0 && (
                            <span style={{ fontSize: '11px', fontWeight: 700, padding: '2px 7px', borderRadius: '999px', background: 'rgba(181,83,58,0.15)', color: 'var(--status-denied)' }}>
                                {blockedIPs.length}
                            </span>
                        )}
                    </div>
                    <button onClick={fetchBlockedIPs} className="btn btn-secondary" style={{ padding: '4px 12px', fontSize: '12px' }}>
                        Refresh
                    </button>
                </div>

                {blockedIPs.length === 0 ? (
                    <p style={{ color: 'var(--text-muted)', fontSize: '13px', textAlign: 'center', padding: '16px 0' }}>
                        No IPs currently blocked.
                    </p>
                ) : (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                        {blockedIPs.map(({ ip, attempts, secsLeft }) => {
                            const mins = Math.floor(secsLeft / 60);
                            const secs = secsLeft % 60;
                            const timeLeft = mins > 0 ? `${mins}m ${secs}s` : `${secs}s`;
                            return (
                                <div key={ip} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '10px 14px', background: 'rgba(181,83,58,0.06)', border: '1px solid rgba(181,83,58,0.18)', borderRadius: '6px', fontSize: '13px', gap: '12px' }}>
                                    <span className="mono" style={{ color: 'var(--text-primary)', flex: '1 1 auto' }}>{ip}</span>
                                    <span style={{ color: 'var(--text-secondary)', whiteSpace: 'nowrap' }}>{attempts} attempts</span>
                                    <span style={{ color: 'var(--status-withdrawn)', whiteSpace: 'nowrap', fontWeight: 600 }}>{timeLeft} left</span>
                                    <button onClick={() => handleUnblock(ip)} className="btn btn-secondary"
                                        style={{ padding: '4px 10px', fontSize: '12px', display: 'flex', alignItems: 'center', gap: '5px', whiteSpace: 'nowrap' }}>
                                        <FiUnlock size={12} /> Unblock
                                    </button>
                                </div>
                            );
                        })}
                    </div>
                )}
            </div>
            </section>
        </div>
    );
};

export default ImportView;
