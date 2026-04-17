import React, { useState, useEffect } from 'react';
import { BrowserRouter as Router, Routes, Route, Link, useLocation } from 'react-router-dom';
import { FiSun, FiMoon } from 'react-icons/fi';
import ImportView from './components/ImportView';
import SearchView from './components/SearchView';
import PermSearchView from './components/PermSearchView';
import CaseDetailsView from './components/CaseDetailsView';
import './index.css';

const Navigation = () => {
  const location = useLocation();
  const isImport = location.pathname === '/import';
  const isPerm = location.pathname === '/perm';
  const isPwd = location.pathname === '/';

  return (
    <div className="nav-tabs">
      <Link to="/" className={`tab ${isPwd ? 'active' : ''}`} style={{ textDecoration: 'none' }}>
        PWD Search
      </Link>
      <Link to="/perm" className={`tab ${isPerm ? 'active' : ''}`} style={{ textDecoration: 'none' }}>
        PERM Search
      </Link>
      <Link to="/import" className={`tab ${isImport ? 'active' : ''}`} style={{ textDecoration: 'none' }}>
        Import Data
      </Link>
    </div>
  );
};

function App() {
  const [theme, setTheme] = useState(() => localStorage.getItem('theme') || 'dark');

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem('theme', theme);
  }, [theme]);

  const toggleTheme = () => setTheme(t => t === 'dark' ? 'light' : 'dark');

  return (
    <Router>
      <div className="app-container">
        <header className="header">
          <div>
            <h1 className="title-gradient">LaborLens</h1>
            <p style={{ color: 'var(--text-secondary)', marginTop: '4px' }}>
              Comprehensive database of PWD and PERM cases
            </p>
          </div>
          <div className="header-right">
            <Navigation />
            <button className="theme-toggle" onClick={toggleTheme} aria-label="Toggle theme">
              {theme === 'dark' ? <FiSun size={18} /> : <FiMoon size={18} />}
            </button>
          </div>
        </header>

        <main className="glass-panel" style={{ padding: '30px' }}>
          <Routes>
            <Route path="/" element={<SearchView />} />
            <Route path="/perm" element={<PermSearchView />} />
            <Route path="/import" element={<ImportView />} />
            <Route path="/cases/:id" element={<CaseDetailsView />} />
          </Routes>
        </main>
      </div>
    </Router>
  );
}

export default App;
