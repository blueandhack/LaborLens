import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { getJSON } from '../utils/api';
import { programs } from '../utils/programs';
import EmployerAutocomplete from './EmployerAutocomplete';
import './Employers.css';

export default function EmployersView({ initialEmployers }) {
  const navigate = useNavigate();
  const [name, setName] = useState('');
  const [query, setQuery] = useState('');
  const [attempt, setAttempt] = useState(0);
  const [response, setResponse] = useState(() => ({ key: initialEmployers ? ':0' : null, employers: initialEmployers || [], error: null }));
  const key = query + ':' + attempt;
  useEffect(() => {
    if (initialEmployers && !query && attempt === 0) return;
    const controller = new AbortController();
    getJSON('/api/employers' + (query ? '?q=' + encodeURIComponent(query) : ''), { signal: controller.signal })
      .then(data => { if (!controller.signal.aborted) setResponse({ key, employers: data.employers, error: null }); })
      .catch(() => { if (!controller.signal.aborted) setResponse({ key, employers: [], error: 'Employer names could not load. Please try again.' }); });
    return () => controller.abort();
  }, [query, key, initialEmployers, attempt]);
  const loading = response.key !== key;
  return <section className="employers-page">
    <header className="employers-intro"><div><p className="section-kicker">Employer research</p><h1>Follow the filings.<br />Understand the employer.</h1><p>Explore H-1B, PERM, and prevailing wage records together, with reported wages, filing history, and original government sources.</p></div>
      <form className="employer-finder" role="search" aria-label="Find an employer" onSubmit={event => { event.preventDefault(); setQuery(name.trim()); }}>
        <EmployerAutocomplete id="employer-directory-name" value={name} onChange={setName} onSelect={employer => navigate('/employers/' + employer.slug)} label="Find a reported employer" placeholder="Start typing a company name" />
        <button className="btn" type="submit">Find employers</button><p>Names come from DOL disclosures. Related companies and punctuation variants are listed separately.</p>
      </form>
    </header>
    <div className="employer-directory-heading"><h2>{query ? `Matches for “${query}”` : 'Explore employer profiles'}</h2>{query && <button type="button" className="text-button" onClick={() => { setQuery(''); setName(''); }}>Show featured employers</button>}</div>
    {loading ? <div className="employer-loading" role="status">Loading employer names…</div> : response.error ? <div className="search-state" role="alert"><p>{response.error}</p><button type="button" className="btn" onClick={() => setAttempt(value => value + 1)}>Try again</button></div>
      : !response.employers.length ? <div className="search-state"><h3>{query ? 'No reported names found' : 'Employer profiles are being prepared'}</h3><p>{query ? 'Try a shorter name or another reported spelling. Historical coverage is still expanding.' : 'You can continue searching cases while the employer directory is updated.'}</p><Link to="/h1b">Search H-1B cases</Link></div>
        : <ul className="employer-directory-list">{response.employers.map(employer => <li key={employer.id}><Link to={'/employers/' + employer.slug}><div><h3>{employer.name}</h3><p>{employer.location || 'Employer location not reported'}</p></div><dl>{Object.entries(employer.programs).map(([program, info]) => <div key={program}><dt>{programs[program].label}</dt><dd>{info.count.toLocaleString()}</dd></div>)}</dl><span className="employer-open">View profile <span aria-hidden="true">↗</span></span></Link></li>)}</ul>}
    <aside className="employer-coverage-note"><strong>Research the records, with their limits.</strong><p>Counts describe imported applications, not workers, visa approvals, current vacancies, or a commitment to sponsor. A reported name does not establish legal identity or common ownership. <Link to="/data">Read the sources and coverage notes.</Link></p></aside>
  </section>;
}
