import { Component, lazy, Suspense, useState, useEffect } from 'react';
import { BrowserRouter as Router, Routes, Route, Link, useLocation } from 'react-router-dom';
import { FiSun, FiMoon, FiGithub } from 'react-icons/fi';
import SearchView from './components/SearchView';
import PermSearchView from './components/PermSearchView';
import './index.css';

const ImportView = lazy(() => import('./components/ImportView'));
const CaseDetailsView = lazy(() => import('./components/CaseDetailsView'));

class PageBoundary extends Component {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() {
    if (this.state.failed) return (
      <div className="search-state" role="alert">
        <h2>This page couldn’t load</h2>
        <p>Reload to get the latest version and try again.</p>
        <button className="btn" onClick={() => window.location.reload()}>Reload page</button>
      </div>
    );
    return this.props.children;
  }
}

const Navigation = () => {
  const location = useLocation();
  const isImport = location.pathname === '/import';
  const isPerm = location.pathname === '/perm';
  const isPwd = location.pathname === '/';

  return (
    <nav className="nav-tabs" aria-label="Main navigation">
      <Link to="/" className={`tab ${isPwd ? 'active' : ''}`} aria-current={isPwd ? 'page' : undefined}>
        PWD Search
      </Link>
      <Link to="/perm" className={`tab ${isPerm ? 'active' : ''}`} aria-current={isPerm ? 'page' : undefined}>
        PERM Search
      </Link>
      <Link to="/import" className={`tab ${isImport ? 'active' : ''}`} aria-current={isImport ? 'page' : undefined}>
        Import Data
      </Link>
    </nav>
  );
};

function App() {
  const [theme, setTheme] = useState(() => document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark');

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    try { localStorage.setItem('theme', theme); } catch { /* Theme still works without browser storage. */ }
  }, [theme]);

  const toggleTheme = () => setTheme(t => t === 'dark' ? 'light' : 'dark');

  return (
    <Router>
      <div className="app-container">
        <a className="skip-link" href="#main-content">Skip to content</a>
        <header className="header">
          <div>
            <Link to={{ pathname: '/', search: '' }} style={{ textDecoration: 'none', color: 'inherit' }}>
              <div className="brand-mark">
                <span className="brand-seal" aria-hidden="true">LL</span>
                <h1 className="brand-name">LaborLens</h1>
              </div>
            </Link>
            <p className="brand-subtitle">U.S. Department of Labor disclosure records</p>
          </div>
          <div className="header-right">
            <Navigation />
            <button className="theme-toggle" onClick={toggleTheme} aria-label="Toggle theme">
              {theme === 'dark' ? <FiSun size={17} /> : <FiMoon size={17} />}
            </button>
          </div>
        </header>

        <main id="main-content" className="glass-panel app-main" tabIndex={-1}>
          <PageBoundary>
          <Suspense fallback={<div className="loading-overlay" role="status"><div className="spinner-large" /><p>Loading page…</p></div>}>
          <Routes>
            <Route path="/" element={<SearchView />} />
            <Route path="/perm" element={<PermSearchView />} />
            <Route path="/import" element={<ImportView />} />
            <Route path="/cases/:id" element={<CaseDetailsView />} />
          </Routes>
          </Suspense>
          </PageBoundary>
        </main>

        <footer className="site-footer">
          <a
            href="https://github.com/blueandhack/LaborLens"
            target="_blank"
            rel="noopener noreferrer"
            className="footer-github-link"
          >
            <FiGithub size={16} />
            <span>Open source on GitHub</span>
          </a>
          <a href="/backups/" className="footer-github-link">LaborLens Backups</a>
          <a href="/privacy/" className="footer-github-link">Privacy</a>
          <a href="/terms/" className="footer-github-link">Terms</a>
        </footer>
      </div>
    </Router>
  );
}

export default App;
