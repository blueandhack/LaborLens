import React, { useState, useRef, useEffect } from 'react';
import { FiUploadCloud, FiFileText, FiLogOut, FiSettings, FiX } from 'react-icons/fi';

const ImportView = () => {
    const [file, setFile] = useState(null);
    const [isDragActive, setIsDragActive] = useState(false);
    const [isUploading, setIsUploading] = useState(false);
    const [isClearing, setIsClearing] = useState(false);
    const [dataType, setDataType] = useState('pwd'); // 'pwd' or 'perm'
    const [logs, setLogs] = useState([]);
    const [progress, setProgress] = useState({ processed: 0, total: 0, percentage: 0, inserted: 0, updated: 0 });
    const [isAuthenticated, setIsAuthenticated] = useState(false);
    const [isCheckingAuth, setIsCheckingAuth] = useState(true);
    const [showChangePassword, setShowChangePassword] = useState(false);
    const [loginForm, setLoginForm] = useState({ username: '', password: '' });
    const [passwordForm, setPasswordForm] = useState({ currentPassword: '', newPassword: '', confirmPassword: '' });
    const [authError, setAuthError] = useState('');
    const [pwdMessage, setPwdMessage] = useState({ type: '', text: '' });

    const fileInputRef = useRef(null);
    const logsEndRef = useRef(null);

    // Initial Auth Check
    useEffect(() => {
        const checkAuth = async () => {
            const token = localStorage.getItem('adminToken');
            if (!token) {
                setIsCheckingAuth(false);
                return;
            }

            try {
                const response = await fetch('/api/admin/check-auth', {
                    headers: { 'Authorization': `Bearer ${token}` }
                });

                if (response.ok) {
                    setIsAuthenticated(true);
                } else {
                    localStorage.removeItem('adminToken');
                    localStorage.removeItem('adminUsername');
                }
            } catch (error) {
                console.error('Auth check error:', error);
                localStorage.removeItem('adminToken');
            } finally {
                setIsCheckingAuth(false);
            }
        };

        checkAuth();
    }, []);

    const scrollToBottom = () => {
        logsEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    };

    useEffect(() => {
        scrollToBottom();
    }, [logs]);

    const handleDrag = (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (e.type === 'dragenter' || e.type === 'dragover') {
            setIsDragActive(true);
        } else if (e.type === 'dragleave') {
            setIsDragActive(false);
        }
    };

    const handleDrop = (e) => {
        e.preventDefault();
        e.stopPropagation();
        setIsDragActive(false);
        if (e.dataTransfer.files && e.dataTransfer.files[0]) {
            setFile(e.dataTransfer.files[0]);
        }
    };

    const handleChange = (e) => {
        e.preventDefault();
        if (e.target.files && e.target.files[0]) {
            setFile(e.target.files[0]);
        }
    };

    const fetchStatus = async () => {
        try {
            const response = await fetch('/api/upload/status');
            if (response.ok) {
                const data = await response.json();

                if (data.status !== 'idle') {
                    // It's actively doing something or finished
                    const pct = data.total > 0 ? Math.min(100, Math.round((data.processed / data.total) * 100)) : 0;

                    setProgress({
                        processed: data.processed || 0,
                        total: data.total || 0,
                        percentage: data.status === 'done' ? 100 : pct,
                        inserted: data.inserted || 0,
                        updated: data.updated || 0
                    });

                    // We only want to show logs if they exist
                    if (data.logs && data.logs.length > 0) {
                        setLogs(data.logs);
                    }

                    if (data.status === 'done' || data.status === 'error') {
                        setIsUploading(false);
                    } else {
                        setIsUploading(true);
                    }
                } else {
                    // It's idle
                    setIsUploading(false);
                }
            }
        } catch (error) {
            console.error('Failed to fetch status:', error);
        }
    };

    const onUpload = async () => {
        if (!file) return;
        setIsUploading(true);
        setLogs(['Uploading file to server...']);
        setProgress({ processed: 0, total: 0, percentage: 0, inserted: 0, updated: 0 });

        const formData = new FormData();
        formData.append('file', file);
        formData.append('type', dataType);

        try {
            const response = await fetch('/api/upload', {
                method: 'POST',
                body: formData,
            });

            if (!response.ok) {
                const errorData = await response.json();
                throw new Error(errorData.error || 'Upload failed');
            }

            // Server responds with 202 immediately. 
            // isUploading is already true, so the polling will take over and update the logs/progress.

        } catch (error) {
            console.error(error);
            setLogs(prev => [...prev, `Error: ${error.message || 'Upload failed'}`]);
            setIsUploading(false);
        } finally {
            setFile(null);
            if (fileInputRef.current) {
                fileInputRef.current.value = '';
            }
        }
    };

    const handleLogin = async (e) => {
        e.preventDefault();
        setAuthError('');
        try {
            const response = await fetch('/api/admin/login', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(loginForm)
            });

            const data = await response.json();

            if (response.ok) {
                localStorage.setItem('adminToken', data.token);
                localStorage.setItem('adminUsername', data.username);
                setIsAuthenticated(true);
            } else {
                setAuthError(data.error || 'Login failed');
            }
        } catch (error) {
            setAuthError('Network error. Please try again.');
        }
    };

    const handleLogout = () => {
        localStorage.removeItem('adminToken');
        localStorage.removeItem('adminUsername');
        setIsAuthenticated(false);
        setLoginForm({ username: '', password: '' });
        setLogs([]);
        setProgress({ processed: 0, total: 0, percentage: 0, inserted: 0, updated: 0 });
    };

    const handleChangePassword = async (e) => {
        e.preventDefault();
        setPwdMessage({ type: '', text: '' });

        if (passwordForm.newPassword !== passwordForm.confirmPassword) {
            setPwdMessage({ type: 'error', text: 'New passwords do not match' });
            return;
        }

        try {
            const token = localStorage.getItem('adminToken');
            const response = await fetch('/api/admin/change-password', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${token}`
                },
                body: JSON.stringify({
                    currentPassword: passwordForm.currentPassword,
                    newPassword: passwordForm.newPassword
                })
            });

            const data = await response.json();

            if (response.ok) {
                setPwdMessage({ type: 'success', text: 'Password updated successfully' });
                setTimeout(() => {
                    setShowChangePassword(false);
                    setPasswordForm({ currentPassword: '', newPassword: '', confirmPassword: '' });
                    setPwdMessage({ type: '', text: '' });
                }, 2000);
            } else {
                setPwdMessage({ type: 'error', text: data.error || 'Failed to update password' });
            }
        } catch (error) {
            setPwdMessage({ type: 'error', text: 'Network error. Please try again.' });
        }
    };

    // Poll status every 1.5 seconds if uploading, and fetch once on mount to check for running jobs
    useEffect(() => {
        if (!isAuthenticated) return;

        fetchStatus(); // Check immediately on mount in case a job is running

        let interval;
        if (isUploading) {
            interval = setInterval(() => {
                fetchStatus();
            }, 1500);
        }

        return () => {
            if (interval) clearInterval(interval);
        };
    }, [isUploading, isAuthenticated]);

    const onClearData = async () => {
        if (!window.confirm(`Are you sure you want to delete ALL ${dataType.toUpperCase()} cases from the database? This action cannot be undone.`)) {
            return;
        }

        setIsClearing(true);
        setLogs(prev => [...prev, `Sending request to clear all ${dataType.toUpperCase()} data...`]);

        try {
            const response = await fetch(`/api/cases?type=${dataType}`, {
                method: 'DELETE',
            });

            const data = await response.json();

            if (response.ok) {
                setLogs(prev => [...prev, `✅ Data cleared successfully! Deleted ${data.deletedCount} records.`]);
            } else {
                throw new Error(data.error || 'Failed to clear data');
            }
        } catch (error) {
            console.error(error);
            setLogs(prev => [...prev, `❌ Error: ${error.message}`]);
        } finally {
            setIsClearing(false);
        }
    };

    if (isCheckingAuth) {
        return (
            <div className="import-container" style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', minHeight: '300px' }}>
                <p>Loading...</p>
            </div>
        );
    }

    if (!isAuthenticated) {
        return (
            <div className="import-container" style={{ maxWidth: '400px', margin: '0 auto', textAlign: 'center' }}>
                <h2 style={{ marginBottom: '24px' }}>Admin Login</h2>
                {authError && <div style={{ color: '#ef4444', marginBottom: '16px', padding: '10px', background: 'rgba(239, 68, 68, 0.1)', borderRadius: '6px' }}>{authError}</div>}
                <form onSubmit={handleLogin} style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
                    <input
                        type="text"
                        placeholder="Username"
                        className="search-input"
                        value={loginForm.username}
                        onChange={(e) => setLoginForm({ ...loginForm, username: e.target.value })}
                        required
                        style={{ width: '100%', boxSizing: 'border-box' }}
                    />
                    <input
                        type="password"
                        placeholder="Password"
                        className="search-input"
                        value={loginForm.password}
                        onChange={(e) => setLoginForm({ ...loginForm, password: e.target.value })}
                        required
                        style={{ width: '100%', boxSizing: 'border-box' }}
                    />
                    <button type="submit" className="btn" style={{ width: '100%', justifyContent: 'center', marginTop: '8px' }}>
                        Login
                    </button>
                </form>
            </div>
        );
    }

    return (
        <div className="import-container" onDragEnter={handleDrag} style={{ position: 'relative' }}>

            <div style={{ position: 'absolute', top: 0, right: 0, display: 'flex', gap: '8px' }}>
                <button
                    onClick={() => setShowChangePassword(true)}
                    className="btn btn-secondary"
                    style={{ padding: '6px 12px', fontSize: '14px', background: 'transparent', border: '1px solid rgba(255,255,255,0.1)' }}
                    title="Change Password"
                >
                    <FiSettings />
                </button>
                <button
                    onClick={handleLogout}
                    className="btn btn-secondary"
                    style={{ padding: '6px 12px', fontSize: '14px', background: 'transparent', border: '1px solid rgba(255,255,255,0.1)' }}
                    title="Logout"
                >
                    <FiLogOut />
                </button>
            </div>

            {showChangePassword && (
                <div style={{
                    position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
                    background: 'rgba(0,0,0,0.7)', backdropFilter: 'blur(5px)',
                    zIndex: 1000, display: 'flex', justifyContent: 'center', alignItems: 'center'
                }}>
                    <div className="glass-panel" style={{ width: '100%', maxWidth: '400px', padding: '24px', position: 'relative' }}>
                        <button
                            onClick={() => {
                                setShowChangePassword(false);
                                setPasswordForm({ currentPassword: '', newPassword: '', confirmPassword: '' });
                                setPwdMessage({ type: '', text: '' });
                            }}
                            style={{ position: 'absolute', top: '16px', right: '16px', background: 'none', border: 'none', color: 'white', cursor: 'pointer', fontSize: '20px' }}
                        >
                            <FiX />
                        </button>
                        <h2 style={{ marginBottom: '24px', fontSize: '1.25rem' }}>Change Password</h2>

                        {pwdMessage.text && (
                            <div style={{
                                color: pwdMessage.type === 'error' ? '#ef4444' : '#10b981',
                                marginBottom: '16px', padding: '10px',
                                background: pwdMessage.type === 'error' ? 'rgba(239, 68, 68, 0.1)' : 'rgba(16, 185, 129, 0.1)',
                                borderRadius: '6px'
                            }}>
                                {pwdMessage.text}
                            </div>
                        )}

                        <form onSubmit={handleChangePassword} style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
                            <input
                                type="password"
                                placeholder="Current Password"
                                className="search-input"
                                value={passwordForm.currentPassword}
                                onChange={(e) => setPasswordForm({ ...passwordForm, currentPassword: e.target.value })}
                                required
                                style={{ width: '100%', boxSizing: 'border-box' }}
                            />
                            <input
                                type="password"
                                placeholder="New Password"
                                className="search-input"
                                value={passwordForm.newPassword}
                                onChange={(e) => setPasswordForm({ ...passwordForm, newPassword: e.target.value })}
                                required
                                style={{ width: '100%', boxSizing: 'border-box' }}
                            />
                            <input
                                type="password"
                                placeholder="Confirm New Password"
                                className="search-input"
                                value={passwordForm.confirmPassword}
                                onChange={(e) => setPasswordForm({ ...passwordForm, confirmPassword: e.target.value })}
                                required
                                style={{ width: '100%', boxSizing: 'border-box' }}
                            />
                            <button type="submit" className="btn" style={{ width: '100%', justifyContent: 'center', marginTop: '8px' }}>
                                Update Password
                            </button>
                        </form>
                    </div>
                </div>
            )}

            <h2 style={{ marginBottom: '16px' }}>Import Excel Dataset</h2>
            <p style={{ color: 'var(--text-secondary)' }}>
                Upload the Excel file (.xlsx) here. The system will track live deduplication to MongoDB.
            </p>

            <div style={{ marginBottom: '20px', display: 'flex', gap: '24px', justifyContent: 'center' }}>
                <label style={{ display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer', color: 'var(--text-primary)' }}>
                    <input
                        type="radio"
                        name="dataType"
                        value="pwd"
                        checked={dataType === 'pwd'}
                        onChange={(e) => setDataType(e.target.value)}
                        style={{ width: '16px', height: '16px', accentColor: 'var(--primary-color)' }}
                    />
                    PWD Data
                </label>
                <label style={{ display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer', color: 'var(--text-primary)' }}>
                    <input
                        type="radio"
                        name="dataType"
                        value="perm"
                        checked={dataType === 'perm'}
                        onChange={(e) => setDataType(e.target.value)}
                        style={{ width: '16px', height: '16px', accentColor: 'var(--primary-color)' }}
                    />
                    PERM Data
                </label>
            </div>

            <div
                className={`drop-zone ${isDragActive ? 'active' : ''}`}
                onDragEnter={handleDrag}
                onDragLeave={handleDrag}
                onDragOver={handleDrag}
                onDrop={handleDrop}
            >
                <FiUploadCloud className="upload-icon" />
                {file ? (
                    <div>
                        <h3 style={{ marginBottom: '8px' }}>{file.name}</h3>
                        <p style={{ color: 'var(--text-secondary)', fontSize: '14px' }}>
                            {(file.size / (1024 * 1024)).toFixed(2)} MB
                        </p>
                    </div>
                ) : (
                    <div>
                        <h3>Drag & Drop your .xlsx file here</h3>
                        <p style={{ color: 'var(--text-secondary)', marginTop: '8px', fontSize: '14px' }}>
                            or click below to select from your computer
                        </p>
                    </div>
                )}
            </div>

            <input
                type="file"
                accept=".xlsx"
                style={{ display: 'none' }}
                ref={fileInputRef}
                onChange={handleChange}
            />

            <div style={{ marginTop: '24px', display: 'flex', gap: '16px', justifyContent: 'center' }}>
                <button
                    className="btn "
                    style={{ backgroundColor: '#ef4444', color: 'white' }}
                    onClick={onClearData}
                    disabled={isUploading || isClearing}
                >
                    {isClearing ? 'Clearing...' : 'Clear All Data'}
                </button>
                <button
                    className="btn btn-secondary"
                    onClick={() => fileInputRef.current?.click()}
                    disabled={isUploading || isClearing}
                >
                    Select File
                </button>
                <button
                    className="btn"
                    onClick={onUpload}
                    disabled={!file || isUploading || isClearing}
                >
                    {isUploading ? 'Processing...' : 'Start Import'}
                </button>
            </div>

            {(isUploading || progress.percentage > 0) && progress.total > 0 && (
                <div style={{ marginTop: '30px', background: 'rgba(255,255,255,0.05)', padding: '20px', borderRadius: '12px', border: '1px solid rgba(255,255,255,0.08)' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '12px' }}>
                        <span style={{ fontWeight: 600, color: '#10b981', display: 'flex', alignItems: 'center', gap: '8px' }}>
                            {progress.percentage === 100 ? '✅ Import Processed' : '⏳ Uploading & Processing'}
                        </span>
                        <span style={{ fontWeight: 600, color: '#10b981' }}>{progress.percentage}%</span>
                    </div>

                    <div style={{ width: '100%', height: '10px', background: 'rgba(0,0,0,0.3)', borderRadius: '5px', overflow: 'hidden' }}>
                        <div style={{ width: `${progress.percentage}%`, height: '100%', background: '#10b981', transition: 'width 0.3s ease' }} />
                    </div>

                    <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: '12px', fontSize: '13px', color: 'var(--text-secondary)' }}>
                        <span>{progress.processed.toLocaleString()} of {progress.total.toLocaleString()} rows verified</span>
                        <span>{progress.inserted.toLocaleString()} newly inserted</span>
                    </div>
                </div>
            )}

            {(logs.length > 0 || isUploading) && (
                <div className="progress-console">
                    {logs.map((log, index) => (
                        <div key={index}>{log}</div>
                    ))}
                    {isUploading && progress.percentage < 100 && (
                        <div className="blinking-cursor" style={{ animation: 'blink 1s step-end infinite' }}>_</div>
                    )}
                    <div ref={logsEndRef} />
                </div>
            )}

            <style dangerouslySetInnerHTML={{
                __html: `
        @keyframes blink {
          0%, 100% { opacity: 1; }
          50% { opacity: 0; }
        }
      `}} />
        </div>
    );
};

export default ImportView;
