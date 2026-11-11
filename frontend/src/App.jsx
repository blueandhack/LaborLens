import { Component, lazy, Suspense, useState, useEffect } from 'react';
import { BrowserRouter as Router, Routes, Route, Link, Navigate } from 'react-router-dom';
import { FiGithub } from 'react-icons/fi';
import SearchView from './components/SearchView';
import PermSearchView from './components/PermSearchView';
import H1bSearchView from './components/H1bSearchView';
import DataGuide from './components/DataGuide';
import EmployerProfile from './components/EmployerProfile';
import EmployersView from './components/EmployersView';
import NotFound from './components/NotFound';
import MapView from './components/MapView';
import UscisView from './components/UscisView';
import I140View from './components/I140View';
import PageSEO from './components/PageSEO';
import SiteHeader from './components/SiteHeader';
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

function App(props) {
  const { RouterComponent = Router, routerProps = {} } = props;
  const [theme, setTheme] = useState(() => typeof document !== 'undefined' && document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark');

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    try { localStorage.setItem('theme', theme); } catch { /* Theme still works without browser storage. */ }
  }, [theme]);

  const toggleTheme = () => setTheme(t => t === 'dark' ? 'light' : 'dark');

  return (
    <RouterComponent {...routerProps}>
      <PageSEO />
      <div className="app-container">
        <a className="skip-link" href="#main-content">Skip to content</a>
        <SiteHeader theme={theme} onToggleTheme={toggleTheme} />

        <main id="main-content" className="glass-panel app-main" tabIndex={-1}>
          <PageBoundary>
          <Suspense fallback={<div className="loading-overlay" role="status"><div className="spinner-large" /><p>Loading page…</p></div>}>
          <Routes>
            <Route path="/" element={<SearchView />} />
            <Route path="/perm" element={<PermSearchView />} />
            <Route path="/h1b" element={<H1bSearchView />} />
            <Route path="/data" element={<DataGuide />} />
            <Route path="/map" element={<MapView />} />
            <Route path="/h1b-approvals" element={<UscisView />} />
            <Route path="/i140" element={<I140View />} />
            <Route path="/employers" element={<EmployersView initialEmployers={props.initialEmployers} />} />
            <Route path="/employers/:slug" element={<EmployerProfile initialProfile={props.initialEmployer} />} />
            <Route path="/admin/data" element={<ImportView />} />
            <Route path="/import" element={<Navigate to="/admin/data" replace />} />
            <Route path="/cases/:id" element={<CaseDetailsView />} />
            <Route path="*" element={<NotFound />} />
          </Routes>
          </Suspense>
          </PageBoundary>
        </main>

        <footer className="site-footer">
          <p className="site-footer-about">
            LaborLens is a free, open-source search of public U.S. Department of Labor and USCIS records on H-1B, PERM, and prevailing wages.
          </p>
          <nav className="footer-nav" aria-label="Footer">
            <Link to="/data" className="footer-link">Data sources</Link>
            <a href="/privacy/" className="footer-link">Privacy</a>
            <a href="/terms/" className="footer-link">Terms</a>
            <a href="https://github.com/blueandhack/LaborLens" target="_blank" rel="noopener noreferrer" className="footer-link">
              <FiGithub size={15} aria-hidden="true" />
              <span>GitHub</span>
            </a>
          </nav>
          {/* Operator-only tools stay linked (Google's OAuth review needs the backups page reachable) but sit apart from reader links. */}
          <nav className="footer-nav footer-nav-operator" aria-label="Site operator">
            <span className="footer-nav-label">Operator</span>
            <Link to="/admin/data" className="footer-link">Administration</Link>
            <a href="/backups/" className="footer-link">Backups</a>
          </nav>
        </footer>
      </div>
    </RouterComponent>
  );
}

export default App;
