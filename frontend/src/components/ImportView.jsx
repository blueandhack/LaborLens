import React, { useState, useRef, useEffect } from 'react';
import { FiUploadCloud, FiLogOut, FiSettings, FiX } from 'react-icons/fi';

const ImportView = () => {
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

    const handleDrop = (e) => {
        e.preventDefault(); e.stopPropagation();
        setIsDragActive(false);
        if (e.dataTransfer.files?.[0]) setFile(e.dataTransfer.files[0]);
    };

    const fetchStatus = async () => {
        try {
            const res = await fetch('/api/upload/status');
            if (!res.ok) return;
            const data = await res.json();
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
        if (!file) return;
        setIsUploading(true);
        setLogs(['Uploading file to server…']);
        setProgress({ processed: 0, total: 0, percentage: 0, inserted: 0, updated: 0 });
        const formData = new FormData();
        formData.append('file', file);
        formData.append('type', dataType);
        try {
            const res = await fetch('/api/upload', { method: 'POST', body: formData });
            if (!res.ok) { const err = await res.json(); throw new Error(err.error || 'Upload failed'); }
        } catch (error) {
            setLogs(prev => [...prev, `Error: ${error.message}`]);
            setIsUploading(false);
        } finally {
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
            const res  = await fetch(`/api/cases?type=${dataType}`, { method: 'DELETE' });
            const data = await res.json();
            if (res.ok) setLogs(prev => [...prev, `✅ Cleared ${data.deletedCount} records.`]);
            else throw new Error(data.error || 'Failed to clear data');
        } catch (error) {
            setLogs(prev => [...prev, `❌ Error: ${error.message}`]);
        } finally { setIsClearing(false); }
    };

    useEffect(() => {
        if (!isAuthenticated) return;
        fetchStatus();
        let iv;
        if (isUploading) iv = setInterval(fetchStatus, 1500);
        return () => { if (iv) clearInterval(iv); };
    }, [isUploading, isAuthenticated]);

    if (isCheckingAuth) {
        return <div className="loading-overlay"><div className="spinner-large" /><p>Checking authentication…</p></div>;
    }

    if (!isAuthenticated) {
        return (
            <div className="import-container" style={{ maxWidth: '380px', margin: '0 auto' }}>
                <h2 style={{ marginBottom: '6px', fontSize: '20px', fontWeight: 700 }}>Admin Login</h2>
                <p style={{ color: 'var(--text-secondary)', fontSize: '13px', marginBottom: '24px' }}>
                    Authentication required to import data.
                </p>
                {authError && (
                    <div style={{ color: '#ef4444', marginBottom: '16px', padding: '10px 14px', background: 'rgba(239,68,68,0.1)', borderRadius: '8px', fontSize: '13px', border: '1px solid rgba(239,68,68,0.2)' }}>
                        {authError}
                    </div>
                )}
                <form onSubmit={handleLogin} style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
                    <input type="text" placeholder="Username" className="search-input"
                        value={loginForm.username} onChange={e => setLoginForm({ ...loginForm, username: e.target.value })} required style={{ width: '100%' }} />
                    <input type="password" placeholder="Password" className="search-input"
                        value={loginForm.password} onChange={e => setLoginForm({ ...loginForm, password: e.target.value })} required style={{ width: '100%' }} />
                    <button type="submit" className="btn" style={{ width: '100%', justifyContent: 'center', marginTop: '4px' }}>
                        Sign In
                    </button>
                </form>
            </div>
        );
    }

    return (
        <div className="import-container" onDragEnter={handleDrag}>
            {/* Top right controls */}
            <div style={{ position: 'absolute', top: 20, right: 20, display: 'flex', gap: '6px' }}>
                <button onClick={() => setShowChangePassword(true)} className="btn btn-secondary"
                    style={{ padding: '6px 10px' }} title="Change Password">
                    <FiSettings size={14} />
                </button>
                <button onClick={handleLogout} className="btn btn-secondary"
                    style={{ padding: '6px 10px' }} title="Logout">
                    <FiLogOut size={14} />
                </button>
            </div>

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
                            <div style={{ color: pwdMessage.type === 'error' ? '#ef4444' : '#22c55e', marginBottom: '14px', padding: '10px 14px', background: pwdMessage.type === 'error' ? 'rgba(239,68,68,0.1)' : 'rgba(34,197,94,0.1)', borderRadius: '8px', fontSize: '13px' }}>
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

            <h2 style={{ marginBottom: '6px', fontSize: '20px', fontWeight: 700 }}>Import Dataset</h2>
            <p style={{ color: 'var(--text-secondary)', fontSize: '13px', marginBottom: '20px' }}>
                Upload a DOL disclosure <span className="mono">.xlsx</span> file. Records are streamed and deduplicated into MongoDB.
            </p>

            {/* Data type selector */}
            <div style={{ display: 'flex', gap: '10px', justifyContent: 'center', marginBottom: '4px' }}>
                {['pwd', 'perm'].map(type => (
                    <label key={type} style={{
                        display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer',
                        padding: '8px 20px', borderRadius: '8px', fontSize: '14px', fontWeight: 500,
                        border: `1px solid ${dataType === type ? 'var(--accent-primary)' : 'var(--border-color)'}`,
                        background: dataType === type ? 'rgba(91,141,238,0.1)' : 'var(--input-bg)',
                        color: dataType === type ? 'var(--accent-primary)' : 'var(--text-secondary)',
                        transition: 'all 0.15s ease',
                    }}>
                        <input type="radio" name="dataType" value={type} checked={dataType === type}
                            onChange={e => setDataType(e.target.value)} style={{ display: 'none' }} />
                        {type.toUpperCase()} Data
                    </label>
                ))}
            </div>

            {/* Drop zone */}
            <div className={`drop-zone ${isDragActive ? 'active' : ''}`}
                onDragEnter={handleDrag} onDragLeave={handleDrag} onDragOver={handleDrag} onDrop={handleDrop}
                onClick={() => fileInputRef.current?.click()}>
                <FiUploadCloud className="upload-icon" />
                {file ? (
                    <div>
                        <p style={{ fontWeight: 600, marginBottom: '4px' }}>{file.name}</p>
                        <p style={{ color: 'var(--text-secondary)', fontSize: '13px' }}>{(file.size / 1024 / 1024).toFixed(2)} MB</p>
                    </div>
                ) : (
                    <div>
                        <p style={{ fontWeight: 500, marginBottom: '6px' }}>Drop your <span className="mono">.xlsx</span> file here</p>
                        <p style={{ color: 'var(--text-secondary)', fontSize: '13px' }}>or click to browse</p>
                    </div>
                )}
            </div>

            <input type="file" accept=".xlsx" style={{ display: 'none' }} ref={fileInputRef} onChange={e => { if (e.target.files?.[0]) setFile(e.target.files[0]); }} />

            {/* Action buttons */}
            <div style={{ marginTop: '20px', display: 'flex', gap: '10px', justifyContent: 'center', flexWrap: 'wrap' }}>
                <button className="btn btn-danger" onClick={onClearData} disabled={isUploading || isClearing}>
                    {isClearing ? 'Clearing…' : `Clear All ${dataType.toUpperCase()}`}
                </button>
                <button className="btn btn-secondary" onClick={() => fileInputRef.current?.click()} disabled={isUploading || isClearing}>
                    Select File
                </button>
                <button className="btn" onClick={onUpload} disabled={!file || isUploading || isClearing}>
                    {isUploading ? 'Processing…' : 'Start Import'}
                </button>
            </div>

            {/* Progress bar */}
            {(isUploading || progress.percentage > 0) && progress.total > 0 && (
                <div style={{ marginTop: '24px', background: 'var(--surface)', padding: '18px 20px', borderRadius: '10px', border: '1px solid var(--border-color)', textAlign: 'left' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '10px', fontSize: '13px' }}>
                        <span style={{ fontWeight: 600, color: progress.percentage === 100 ? 'var(--status-certified)' : 'var(--accent-primary)' }}>
                            {progress.percentage === 100 ? '✓ Import complete' : '⏳ Processing…'}
                        </span>
                        <span style={{ fontWeight: 600, color: 'var(--text-primary)' }}>{progress.percentage}%</span>
                    </div>
                    <div style={{ width: '100%', height: '6px', background: 'var(--progress-track)', borderRadius: '3px', overflow: 'hidden' }}>
                        <div style={{ width: `${progress.percentage}%`, height: '100%', background: progress.percentage === 100 ? 'var(--status-certified)' : 'var(--accent-primary)', borderRadius: '3px', transition: 'width 0.3s ease' }} />
                    </div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: '10px', fontSize: '12px', color: 'var(--text-secondary)' }}>
                        <span>{progress.processed.toLocaleString()} / {progress.total.toLocaleString()} rows</span>
                        <span>{progress.inserted.toLocaleString()} inserted</span>
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
    );
};

export default ImportView;
