import { Link } from 'react-router-dom';

export default function NotFound() {
  return <section className="search-state"><h1>Page not found</h1><p>Use a program search to find public DOL records by employer, job title, or case number.</p><div className="data-program-links"><Link to="/h1b">H-1B search</Link><Link to="/perm">PERM search</Link><Link to="/">Prevailing wage search</Link></div></section>;
}
