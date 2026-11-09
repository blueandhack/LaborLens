import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { FiArrowRight, FiRefreshCw } from 'react-icons/fi';
import { getJSON } from '../utils/api';
import { stateName } from '../utils/states';
import {
  SERIES, USCIS_SORTS, apiQuery, coverageLabel, formatCount, formatRate, fyLabel, location, rate, readUscisState, seriesValues, writeUscisState,
} from '../utils/uscisPresentation';
import { ApprovalsChart, DenialRateChart, TrendTable } from './UscisCharts';
import './UscisView.css';

function useJSON(url) {
  const [response, setResponse] = useState({ url: null, data: null, error: null });
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    getJSON(url, { signal: controller.signal })
      .then(data => setResponse({ url, data, error: null }))
      .catch(error => { if (!controller.signal.aborted) setResponse({ url, data: null, error: error.status === 400 ? error.message : 'USCIS approval data could not load. Please try again.' }); });
    return () => controller.abort();
  }, [url, retry]);
  const loading = response.url !== url;
  return { ...response, loading, retry: () => setRetry(value => value + 1) };
}

function Stat({ label, value, detail }) {
  return <div className="uscis-stat"><dt>{label}</dt><dd>{value}</dd><small>{detail}</small></div>;
}

function Employers({ state, update, industries }) {
  const { data, error, loading, retry } = useJSON('/api/uscis-h1b/employers?' + apiQuery(state, ['fy', 'state', 'industry', 'q', 'sort', 'page']));
  const [draft, setDraft] = useState(state.q);
  const [shownQ, setShownQ] = useState(state.q);
  // The URL changed (back/forward or a cleared filter): show its query in the box.
  if (shownQ !== state.q) { setShownQ(state.q); if (draft.trim() !== state.q) setDraft(state.q); }
  useEffect(() => {
    if (draft.trim() === state.q) return undefined;
    const timer = setTimeout(() => update({ q: draft, page: 1 }), 350);
    return () => clearTimeout(timer);
  }, [draft]); // eslint-disable-line react-hooks/exhaustive-deps
  const rows = data?.employers || [];
  return <section className="uscis-employers" aria-labelledby="uscis-employers-title">
    <header>
      <div><h2 id="uscis-employers-title">Petitioners</h2><p>Each row combines the spellings of one petitioner name; underlined names link to the matching LaborLens employer profile.{state.fy === 'all' ? ' Rankings count every imported fiscal year, including partial ones.' : ''}</p></div>
      <div className="uscis-employer-controls">
        <label htmlFor="uscis-search">Petitioner name<input id="uscis-search" className="search-input" type="search" value={draft} placeholder="Starts with…" autoComplete="off"
          onChange={event => setDraft(event.target.value)} onKeyDown={event => { if (event.key === 'Enter') update({ q: draft, page: 1 }); }} /></label>
        <label htmlFor="uscis-sort">Sort<select id="uscis-sort" className="search-input" value={state.sort} onChange={event => update({ sort: event.target.value, page: 1 })}>
          {Object.entries(USCIS_SORTS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
      </div>
    </header>
    {state.sort === 'denialRate' && <p className="uscis-note">Only petitioners with at least 20 decisions in this selection are ranked by denial rate.</p>}
    {error ? <div className="search-state" role="alert"><p>{error}</p><button className="btn" type="button" onClick={retry}>Try again</button></div>
      : <div className={`uscis-table-scroll${loading ? ' is-loading' : ''}`} aria-busy={loading}><table className="uscis-employer-table">
        <thead><tr><th scope="col">Petitioner</th><th scope="col">Initial approved</th><th scope="col">Initial denied</th><th scope="col">Continuing approved</th><th scope="col">Continuing denied</th><th scope="col">Denial rate</th></tr></thead>
        <tbody>{rows.map(row => <tr key={row.key}>
          <th scope="row"><span className="uscis-employer-name">{row.profile ? <Link to={'/employers/' + row.profile}>{row.name}</Link> : row.name}</span>
            <small>{[location(row.location), industries.find(item => item.code === row.industry)?.label].filter(Boolean).join(' · ')}</small></th>
          <td>{formatCount(row.initialApprovals)}</td><td>{formatCount(row.initialDenials)}</td><td>{formatCount(row.continuingApprovals)}</td><td>{formatCount(row.continuingDenials)}</td>
          <td>{row.denialRate === null ? <span title="Fewer than 20 decisions">—</span> : formatRate(row.denialRate)}</td>
        </tr>)}</tbody>
      </table>
      {!loading && !rows.length && <p className="uscis-empty">No petitioner {state.q ? <>name starts with “{state.q}”</> : 'matches'} in this selection.</p>}
      </div>}
    <nav className="uscis-pages" aria-label="Petitioner pages">
      <button className="btn btn-secondary" type="button" disabled={state.page <= 1} onClick={() => update({ page: state.page - 1 })}>Previous</button>
      <span>Page {state.page}</span>
      <button className="btn btn-secondary" type="button" disabled={!data?.hasNextPage} onClick={() => update({ page: state.page + 1 })}>Next</button>
    </nav>
  </section>;
}

export default function UscisView() {
  const [params, setParams] = useSearchParams();
  const state = readUscisState(params);
  const update = changes => setParams(writeUscisState({ ...state, page: 1, ...changes }));
  // While a new selection loads, the previous one stays on screen (dimmed).
  const overview = useJSON('/api/uscis-h1b?' + apiQuery(state, ['fy', 'state', 'industry']));
  const data = overview.data;
  const [hover, setHover] = useState(null);
  const selectedYear = state.fy === 'all' ? null : Number(state.fy);

  const intro = <header className="uscis-intro">
    <p className="section-kicker">USCIS H-1B Employer Data Hub</p>
    <h1>H-1B petition approvals and denials</h1>
    <p>How often U.S. Citizenship and Immigration Services approved or denied H-1B petitions, by fiscal year, petitioner, state and industry. These are USCIS decisions on petitions, the step after the Department of Labor certifies a labor condition application.</p>
  </header>;

  if (!data) return <article className="uscis-page">{intro}
    {overview.error ? <div className="search-state" role="alert"><p>{overview.error}</p><button className="btn" type="button" onClick={overview.retry}><FiRefreshCw aria-hidden="true" /> Try again</button></div>
      : <div className="employer-loading" role="status">Loading USCIS decisions…</div>}</article>;
  if (!data.available) return <article className="uscis-page">{intro}<div className="search-state"><h2>USCIS data is being prepared</h2><p>The H-1B Employer Data Hub files have not been imported yet. Please check back soon.</p></div></article>;

  const years = data.years;
  const trend = data.trend;
  const totals = data.totals, values = seriesValues(totals);
  const partialYears = years.filter(year => year.partial);
  const scope = [selectedYear ? fyLabel(selectedYear) : coverageLabel(years, { excludePartial: data.totalsExcludePartial }),
    state.state && stateName(state.state), state.industry && data.industries.find(item => item.code === state.industry)?.label].filter(Boolean).join(' · ');
  const filtered = state.fy !== 'all' || state.state || state.industry;
  const missingRecent = years.length && years.at(-1).fiscalYear < new Date().getUTCFullYear() - 1;

  return <article className="uscis-page">
    {intro}
    <form className="uscis-controls" aria-label="Filter USCIS decisions" onSubmit={event => event.preventDefault()}>
      <label htmlFor="uscis-fy">Fiscal year<select id="uscis-fy" className="search-input" value={state.fy} onChange={event => update({ fy: event.target.value })}>
        <option value="all">All fiscal years</option>
        {[...years].reverse().map(year => <option key={year.fiscalYear} value={year.fiscalYear}>{fyLabel(year.fiscalYear)}{year.partial ? ' (partial)' : ''}</option>)}
      </select></label>
      <label htmlFor="uscis-state">Petitioner state<select id="uscis-state" className="search-input" value={state.state} onChange={event => update({ state: event.target.value })}>
        <option value="">All states</option>
        {data.states.map(code => <option key={code} value={code}>{stateName(code)}</option>)}
      </select></label>
      <label htmlFor="uscis-industry" className="uscis-industry">Industry (NAICS)<select id="uscis-industry" className="search-input" value={state.industry} onChange={event => update({ industry: event.target.value })}>
        <option value="">All industries</option>
        {data.industries.map(item => <option key={item.code} value={item.code}>{item.code} · {item.label}</option>)}
      </select></label>
      {filtered && <button type="button" className="text-button" onClick={() => setParams(writeUscisState({ sort: state.sort }))}>Clear filters</button>}
    </form>

    <section className={`uscis-summary${overview.loading ? ' is-loading' : ''}`} aria-labelledby="uscis-summary-title" aria-busy={overview.loading}>
      <h2 id="uscis-summary-title">{scope}</h2>
      {data.totalsExcludePartial && <p className="uscis-note">Totals leave out {partialYears.map(year => fyLabel(year.fiscalYear)).join(', ')}, which covers only part of the year. Select it to see it on its own.</p>}
      <dl className="uscis-stats">
        <Stat label="Initial petitions approved" value={formatCount(values.initial.approvals)} detail={`${formatCount(values.initial.denials)} denied`} />
        <Stat label="Initial denial rate" value={formatRate(values.initial.rate)} detail="of initial decisions" />
        <Stat label="Continuing petitions approved" value={formatCount(values.continuing.approvals)} detail={`${formatCount(values.continuing.denials)} denied`} />
        <Stat label="Continuing denial rate" value={formatRate(values.continuing.rate)} detail="of continuing decisions" />
      </dl>
      <p className="uscis-note">Counts are workers on petitions, at USCIS’s first decision. Overall denial rate: {formatRate(rate(values.initial.denials + values.continuing.denials, values.initial.approvals + values.continuing.approvals))}.</p>
    </section>

    <section className="uscis-trends" aria-label="Decisions by fiscal year">
      <ul className="uscis-legend" aria-label="Petition types">
        {SERIES.map(series => <li key={series.key}><i className={`uscis-swatch is-${series.key}`} aria-hidden="true" /><strong>{series.label}</strong><span>{series.description}</span></li>)}
        {partialYears.length > 0 && <li><i className="uscis-swatch is-partial" aria-hidden="true" /><strong>* Partial year</strong><span>{partialYears.map(year => year.note || `${fyLabel(year.fiscalYear)} is incomplete.`).join(' ')}</span></li>}
      </ul>
      <div className="uscis-charts">
        <ApprovalsChart rows={trend} selected={selectedYear} hover={hover} onHover={setHover} onSelect={year => update({ fy: String(year) })} />
        <DenialRateChart rows={trend} selected={selectedYear} hover={hover} onHover={setHover} onSelect={year => update({ fy: String(year) })} />
      </div>
      <p className="uscis-note">Select a year to filter the page. {state.state || state.industry ? 'Charts follow the state and industry filters. ' : ''}Source: USCIS H-1B Employer Data Hub.</p>
      <TrendTable rows={trend} />
    </section>

    <Employers state={state} industries={data.industries} update={changes => setParams(writeUscisState({ ...state, ...changes }))} />

    <section className="uscis-method" aria-labelledby="uscis-method-title">
      <h2 id="uscis-method-title">What these numbers mean</h2>
      <ul>
        <li><strong>First decisions only.</strong> A petition counts in the fiscal year USCIS first approved or denied it (October through September). Later outcomes, such as appeals or revocations, are not included, nor are petitions still pending.</li>
        <li><strong>Workers, not petitions.</strong> Counts are approved or denied workers (beneficiaries); one petition can name several.</li>
        <li><strong>Initial and continuing.</strong> {SERIES.map(series => `${series.label}: ${series.description.toLowerCase()}.`).join(' ')}</li>
        <li><strong>Petitioner location.</strong> State and city are the petitioner’s mailing address, not where the employee works. Industry is the two-digit NAICS code the petitioner reported (99: unknown).</li>
        <li><strong>Names as filed.</strong> USCIS uses the most common spelling for each tax ID; older files abbreviate and cut names short. LaborLens combines spellings that differ only in punctuation or common abbreviations, and joins a cut-off name to the full name it begins with. Data is entered from paper forms and may contain errors.</li>
        {missingRecent && <li><strong>Coverage.</strong> LaborLens has {coverageLabel(years)}. USCIS currently publishes later fiscal years only in its interactive hub; they will be added when they can be imported.</li>}
      </ul>
      <p>Source: <a href="https://www.uscis.gov/tools/reports-and-studies/h-1b-employer-data-hub" target="_blank" rel="noreferrer">USCIS H-1B Employer Data Hub</a> · <Link to="/data">LaborLens sources and methodology <FiArrowRight aria-hidden="true" /></Link></p>
    </section>
  </article>;
}
