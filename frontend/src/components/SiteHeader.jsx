import { useEffect, useId, useRef, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { FiAward, FiBriefcase, FiCheckCircle, FiClipboard, FiDollarSign, FiFileText, FiMap, FiMenu, FiMoon, FiSun, FiX } from 'react-icons/fi';
import { NAV_GROUPS, MENU_LINKS, activeNavItem, currentPageLabel } from '../utils/navigation.js';
import './SiteHeader.css';
import { prefetchRoute } from '../utils/prefetch';

const ICONS = { '/': FiDollarSign, '/perm': FiFileText, '/h1b': FiClipboard, '/h1b-approvals': FiCheckCircle, '/i140': FiAward, '/employers': FiBriefcase, '/map': FiMap };
// Must match the small-screen breakpoint in SiteHeader.css.
const COMPACT_QUERY = '(max-width: 720px)';

export default function SiteHeader({ theme, onToggleTheme }) {
  const { pathname } = useLocation();
  // The menu belongs to the page it was opened on, so any navigation closes it.
  const [openOn, setOpenOn] = useState(null);
  const open = openOn === pathname;
  const header = useRef(null);
  const button = useRef(null);
  const menuId = useId();
  const active = activeNavItem(pathname);
  const close = () => setOpenOn(null);

  useEffect(() => {
    if (!open) return undefined;
    const media = window.matchMedia(COMPACT_QUERY);
    const onKey = event => { if (event.key === 'Escape') { setOpenOn(null); button.current?.focus(); } };
    const onMedia = () => { if (!media.matches) setOpenOn(null); };
    document.addEventListener('keydown', onKey);
    media.addEventListener('change', onMedia);
    document.body.classList.add('site-menu-open');
    header.current?.querySelector('.site-nav [aria-current="page"]')?.focus({ preventScroll: true });
    return () => {
      document.removeEventListener('keydown', onKey);
      media.removeEventListener('change', onMedia);
      document.body.classList.remove('site-menu-open');
    };
  }, [open]);

  // Keyboard users who tab past the menu leave it closed behind them.
  const onBlur = event => { if (open && event.relatedTarget && !header.current?.contains(event.relatedTarget)) close(); };

  return (
    <header ref={header} className={`site-header${open ? ' is-open' : ''}`} onBlur={onBlur}>
      <div className="site-bar">
        <div className="site-brand">
          <Link to={{ pathname: '/', search: '' }} className="site-brand-link" aria-label="LaborLens home">
            <span className="brand-seal" aria-hidden="true">LL</span>
            <span className="brand-name">LaborLens</span>
          </Link>
          <p className="brand-subtitle">U.S. Department of Labor and USCIS disclosure records</p>
        </div>
        <button ref={button} type="button" className="menu-button" aria-expanded={open} aria-controls={menuId}
          onClick={() => setOpenOn(open ? null : pathname)}>
          <span className="sr-only">Menu, </span>
          <span className="menu-button-label">{currentPageLabel(pathname)}</span>
          {open ? <FiX size={18} aria-hidden="true" /> : <FiMenu size={18} aria-hidden="true" />}
        </button>
      </div>

      <div className="site-menu" id={menuId}>
        <nav className="site-nav" aria-label="Main navigation">
          {NAV_GROUPS.map(group => (
            <div key={group.id} className={`nav-group nav-group-${group.id}`} role="group" aria-labelledby={`${menuId}-${group.id}`}>
              <span className="nav-group-label" id={`${menuId}-${group.id}`}>{group.label}</span>
              <ul className="nav-group-items">
                {group.items.map(item => {
                  const Icon = ICONS[item.to];
                  const current = active?.to === item.to;
                  return (
                    <li key={item.to}>
                      <Link to={item.to} className="nav-link" title={item.description} aria-current={current ? 'page' : undefined} onClick={close}
                        onPointerEnter={() => prefetchRoute(item.to)} onFocus={() => prefetchRoute(item.to)} onTouchStart={() => prefetchRoute(item.to)}>
                        <Icon className="nav-link-icon" aria-hidden="true" />
                        <span className="nav-link-label">{item.label}</span>
                        <span className="nav-link-description">{item.description}</span>
                      </Link>
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
        </nav>
        <div className="site-menu-footer">
          {MENU_LINKS.map(link => (
            <Link key={link.to} to={link.to} className="menu-extra-link" aria-current={pathname === link.to ? 'page' : undefined} onClick={close}>{link.label}</Link>
          ))}
          <button type="button" className="theme-toggle" onClick={onToggleTheme} aria-label={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}>
            {theme === 'dark' ? <FiSun size={17} aria-hidden="true" /> : <FiMoon size={17} aria-hidden="true" />}
            <span className="theme-toggle-text">{theme === 'dark' ? 'Light theme' : 'Dark theme'}</span>
          </button>
        </div>
      </div>
      <div className="site-menu-backdrop" aria-hidden="true" onClick={close} />
    </header>
  );
}
