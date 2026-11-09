import { useEffect, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { getJSON } from '../utils/api';
import { programs } from '../utils/programs';
import { employerSortOptions } from '../utils/sorting';
import EmployerAutocomplete from './EmployerAutocomplete';
import './Employers.css';

function EmployerFinder({ query, onSearch }) {
  const navigate = useNavigate();
  const [name, setName] = useState(query);
  return <form className="employer-finder" role="search" aria-label="Find an employer" onSubmit={event => { event.preventDefault(); onSearch(name.trim()); }}>
    <EmployerAutocomplete id="employer-directory-name" value={name} onChange={setName} onSelect={employer => navigate('/employers/' + employer.slug)} label="Find a reported employer" placeholder="Start typing a company name" />
    <button className="btn" type="submit">Find employers</button><p>Names come from DOL disclosures. Spelling variants of one employer are combined; related companies with different names stay separate.</p>
  </form>;
}

export default function EmployersView({ initialEmployers }) {
  const [params, setParams] = useSearchParams();
  const query = params.get('q') || '';
  const sort = employerSortOptions.some(option => option.value === params.get('sort')) ? params.get('sort') : 'h1b_desc';
  const requestedPage = Number(params.get('page') || 1);
  const page = Number.isSafeInteger(requestedPage) && requestedPage > 0 && requestedPage <= 100000 ? requestedPage : 1;
  const [attempt, setAttempt] = useState(0);
  const key = JSON.stringify([query, sort, page, attempt]);
  const initial = initialEmployers && !Array.isArray(initialEmployers) ? initialEmployers : null;
  const [response, setResponse] = useState(() => ({ key: initial ? key : null, data: initial, error: null }));
  useEffect(() => {
    if (initial && query === initial.query && sort === initial.sort && page === initial.page && attempt === 0) return;
    const controller = new AbortController();
    const search = new URLSearchParams({ directory: '1', sort, page: String(page), ...(query ? { q: query } : {}) });
    getJSON('/api/employers?' + search, { signal: controller.signal })
      .then(data => { if (!controller.signal.aborted) setResponse({ key, data, error: null }); })
      .catch(() => { if (!controller.signal.aborted) setResponse({ key, data: null, error: 'Employer names could not load. Please try again.' }); });
    return () => controller.abort();
  }, [query, sort, page, key, initial, attempt]);
  const initialMatches = Boolean(initial && query === initial.query && sort === initial.sort && page === initial.page && attempt === 0);
  // The server-rendered first response remains usable on browser Back.
  const data = initialMatches ? initial : response.key === key ? response.data : null;
  const pending = !initialMatches && response.key !== key;
  const error = !initialMatches && !pending && response.error;
  const update = (nextQuery = query, nextSort = sort, nextPage = 1) => {
    const next = new URLSearchParams();
    if (nextQuery) next.set('q', nextQuery);
    if (nextSort !== 'h1b_desc') next.set('sort', nextSort);
    if (nextPage > 1) next.set('page', String(nextPage));
    setParams(next);
    requestAnimationFrame(() => document.querySelector('.employer-directory-heading')?.scrollIntoView({ block: 'start', behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth' }));
  };
  return <section className="employers-page">
    <header className="employers-intro"><div><p className="section-kicker">Employer research</p><h1>Follow the filings.<br />Understand the employer.</h1><p>Explore H-1B, PERM, and prevailing wage records together, with reported wages, filing history, and original government sources.</p></div>
      <EmployerFinder key={query} query={query} onSearch={value => update(value)} />
    </header>
    <div className="employer-directory-heading"><div><h2>{query ? `Matches for “${query}”` : 'Browse reported employers'}</h2><p>Each employer combines its reported spellings across H-1B, PERM, and prevailing wage filings. Counts include all imported years.</p></div>
      <div className="employer-directory-controls">{query && <button type="button" className="text-button" onClick={() => update('')}>Clear employer search</button>}
        <label className="result-sort">Sort by<select className="search-input" aria-label="Sort employers" value={sort} onChange={event => update(query, event.target.value)}>{employerSortOptions.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label>
      </div>
    </div>
    {pending ? <div className="employer-loading" role="status">Loading employer names…</div> : error ? <div className="search-state" role="alert"><p>{error}</p><button type="button" className="btn" onClick={() => setAttempt(value => value + 1)}>Try again</button></div>
      : !data?.employers.length ? <div className="search-state"><h3>No employers found</h3><p>Try a shorter name, another reported spelling, or the first page.</p>{page > 1 && <button className="btn" type="button" onClick={() => update(query, sort)}>First page</button>}<Link to="/h1b">Search H-1B cases</Link></div>
        : <ul className="employer-directory-list">{data.employers.map(employer => <li key={employer.id}><Link to={'/employers/' + employer.slug}><div><h3>{employer.name}</h3><p>{employer.location || 'Employer location not reported'}</p>{employer.groupId && <p className="employer-group-link">Combines {employer.names.toLocaleString()} reported filing names</p>}</div><dl>{['h1b', 'perm', 'pwd'].map(program => <div key={program}><dt>{programs[program].label}</dt><dd>{(employer.programs[program]?.count || 0).toLocaleString()}</dd></div>)}</dl><span className="employer-open">View profile <span aria-hidden="true">↗</span></span></Link></li>)}</ul>}
    {data && !pending && !error && <nav className="pagination" aria-label="Employer directory pages"><button type="button" className="btn btn-secondary" disabled={page <= 1} onClick={() => update(query, sort, page - 1)}>Previous</button><span className="page-info">Page <strong>{page.toLocaleString()}</strong></span><button type="button" className="btn btn-secondary" disabled={!data.hasNextPage || page >= 100000} onClick={() => update(query, sort, page + 1)}>Next</button></nav>}
    <aside className="employer-coverage-note"><strong>Research the records, with their limits.</strong><p>Counts describe imported applications, not workers, visa approvals, current vacancies, or a commitment to sponsor. Combined names share a normalized spelling or a reported employer FEIN; they do not establish common ownership of related companies. <Link to="/data">Read the sources and coverage notes.</Link></p></aside>
  </section>;
}
