import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { FiRefreshCw } from 'react-icons/fi';
import { formatCount, formatImportDate, programLabel } from '../utils/importPresentation';
import { describeEvent, elapsed, formatDuration, mapState, percent, refreshState } from '../utils/siteStatusPresentation';
import './SiteDataStatus.css';

const Pill = ({ tone, children }) => <span className={`site-status-pill ${tone}`}>{children}</span>;

function RefreshRun({ refresh }) {
  const state = refreshState(refresh);
  return <section className="site-status-card" aria-labelledby="site-refresh-heading">
    <header><div><h4 id="site-refresh-heading">Nightly refresh</h4><p className="admin-help">Daily at 2:30 AM Pacific: worksite fields, employer directory and identities, the worksite map, then featured profiles.</p></div><Pill tone={state.tone}>{state.label}</Pill></header>
    {refresh && <>
      <dl className="site-status-facts">
        <div><dt>{refresh.running ? 'Started' : 'Last started'}</dt><dd>{formatImportDate(refresh.startedAt)}</dd></div>
        <div><dt>{refresh.running ? 'Running for' : 'Duration'}</dt><dd>{refresh.running ? elapsed(refresh.startedAt) : elapsed(refresh.startedAt, refresh.finishedAt)}</dd></div>
        <div><dt>Current step</dt><dd>{refresh.running ? refresh.step || 'Starting' : '—'}</dd></div>
        <div><dt>Options</dt><dd><code>{(refresh.args || []).join(' ') || 'all steps'}</code></dd></div>
      </dl>
      {refresh.running && describeEvent(refresh.lastEvent) && <p className="site-status-event" role="status">Latest progress: {describeEvent(refresh.lastEvent)} <span>· {formatImportDate(refresh.lastEvent.at)}</span></p>}
      {refresh.interrupted && <p className="import-notice error">The run stopped without recording its end (the job was stopped or evicted). The next scheduled run starts over.</p>}
      {refresh.error && !refresh.running && <p className="import-notice error">Error: {refresh.error}</p>}
      {refresh.steps?.length > 0 && <ol className="site-status-steps">{refresh.steps.map(step => <li key={step.name + step.startedAt}>
        <span>{step.name}</span><span>{step.finishedAt ? formatDuration(new Date(step.finishedAt) - new Date(step.startedAt)) : refresh.running && !refresh.interrupted ? 'in progress' : 'stopped'}</span></li>)}</ol>}
      {refresh.history?.length > 0 && <details className="site-status-history"><summary>Recent runs ({refresh.history.length})</summary>
        <table><thead><tr><th scope="col">Started</th><th scope="col">Duration</th><th scope="col">Result</th><th scope="col">Steps</th></tr></thead>
          <tbody>{refresh.history.map(run => <tr key={run.runId}><td>{formatImportDate(run.startedAt)}</td><td>{elapsed(run.startedAt, run.finishedAt)}</td>
            <td><Pill tone={run.outcome === 'failed' ? 'error' : 'success'}>{run.outcome === 'failed' ? 'Failed' : 'Succeeded'}</Pill>{run.error && <small>{run.error}</small>}</td>
            <td>{run.steps?.join(' → ') || '—'}</td></tr>)}</tbody></table>
      </details>}
    </>}
  </section>;
}

function MapBuilds({ rows }) {
  return <section className="site-status-card" aria-labelledby="site-map-heading">
    <header><div><h4 id="site-map-heading">Worksite map</h4><p className="admin-help">Summaries behind <Link to="/map">/map</Link> and employer worksite areas. A program is rebuilt only when its cases change.</p></div></header>
    <div className="site-status-table"><table>
      <thead><tr><th scope="col">Program</th><th scope="col">Status</th><th scope="col">Last built</th><th scope="col">Filings mapped</th><th scope="col">In a metro area</th><th scope="col">Years</th><th scope="col">Occupations</th></tr></thead>
      <tbody>{rows.map(row => {
        const state = mapState(row), built = row.built;
        return <tr key={row.program}>
          <th scope="row">{programLabel(row.program)}<small>{formatCount(row.cases)} cases now</small></th>
          <td><Pill tone={state.tone}>{state.label}</Pill><small>{state.detail}</small>
            {row.build?.state === 'building' && !row.build.interrupted && <small>Started {formatImportDate(row.build.startedAt)} · {elapsed(row.build.startedAt)} so far</small>}</td>
          <td>{built ? formatImportDate(built.updatedAt) : '—'}{row.build?.durationMs != null && row.build.state !== 'building' && <small>Took {formatDuration(row.build.durationMs)}</small>}</td>
          <td>{built ? <>{formatCount(built.located)}<small>{percent(built.located, built.total)} of {formatCount(built.total)}</small></> : '—'}</td>
          <td>{built ? <>{formatCount(built.metroLocated)}<small>{percent(built.metroLocated, built.total)}</small></> : '—'}</td>
          <td>{built?.years ? `${built.years[0]}–${built.years[1]}` : '—'}</td>
          <td>{built ? formatCount(built.occupations) : '—'}</td>
        </tr>;
      })}</tbody>
    </table></div>
  </section>;
}

function UscisData({ uscis, onImported }) {
  const [file, setFile] = useState(null);
  const [message, setMessage] = useState({ tone: '', text: '' });
  const [sending, setSending] = useState(false);
  const job = uscis?.job;
  const years = uscis?.years || [];
  const send = async event => {
    event.preventDefault();
    if (!file) return;
    setSending(true); setMessage({ tone: '', text: '' });
    try {
      const body = new FormData(); body.append('file', file);
      const response = await fetch('/api/uscis-h1b/import', { method: 'POST', body, headers: { Authorization: `Bearer ${localStorage.getItem('adminToken')}` } });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || 'The file could not be imported.');
      setMessage({ tone: 'success', text: `Importing ${formatCount(data.rows)} rows for FY${data.years.join(', FY')}.` });
      setFile(null); event.target.reset(); onImported();
    } catch (failure) { setMessage({ tone: 'error', text: failure.message }); }
    finally { setSending(false); }
  };
  return <section className="site-status-card" aria-labelledby="site-uscis-heading">
    <header><div><h4 id="site-uscis-heading">USCIS H-1B decisions</h4><p className="admin-help">Petition approvals and denials behind <Link to="/h1b-approvals">/h1b-approvals</Link> and employer profiles. The current and previous fiscal years are re-downloaded from the hub monthly (the 3rd, 5:30 AM Pacific), and petitioner names are re-linked to employers nightly.</p></div>
      <Pill tone={job?.state === 'importing' ? 'active' : job?.state === 'failed' ? 'error' : years.length ? 'success' : 'warning'}>{job?.state === 'importing' ? 'Importing' : job?.state === 'failed' ? 'Last import failed' : years.length ? 'Ready' : 'Not imported'}</Pill></header>
    {job?.state === 'importing' && <p className="site-status-event" role="status">{job.phase || 'Importing'}: {job.file} · started {formatImportDate(job.startedAt)}</p>}
    {job?.state === 'failed' && <p className="import-notice error">{job.file}: {job.error}</p>}
    {years.length > 0 && <>
      <dl className="site-status-facts">
        <div><dt>Fiscal years</dt><dd>FY{years[0].fiscalYear}–FY{years.at(-1).fiscalYear}</dd></div>
        <div><dt>Petitioner names</dt><dd>{formatCount(uscis.employers)}</dd></div>
        <div><dt>Linked to employers</dt><dd>{formatCount(uscis.linked)} <small>{percent(uscis.linked, uscis.employers)}</small></dd></div>
        <div><dt>Updated</dt><dd>{formatImportDate(uscis.updatedAt)}</dd></div>
      </dl>
      <details className="site-status-history"><summary>Imported fiscal years ({years.length})</summary>
        <table><thead><tr><th scope="col">Fiscal year</th><th scope="col">Rows</th><th scope="col">Source</th><th scope="col">Imported</th></tr></thead>
          <tbody>{[...years].reverse().map(year => <tr key={year.fiscalYear}><td>FY{year.fiscalYear}{year.partial && <small>Partial year</small>}</td><td>{formatCount(year.rows)}</td>
            <td>{year.source?.url ? <a href={year.source.url} target="_blank" rel="noreferrer">{year.source.name}</a> : year.source?.name || '—'}{year.source && !year.source.official && <small>Uploaded export</small>}</td>
            <td>{formatImportDate(year.importedAt)}</td></tr>)}</tbody></table>
      </details>
    </>}
    <form className="site-status-upload" onSubmit={send}>
      <label htmlFor="uscis-file">Add or replace fiscal years<input id="uscis-file" type="file" accept=".csv,.txt,text/csv,text/plain" onChange={event => setFile(event.target.files[0] || null)} /></label>
      <button className="btn btn-secondary" type="submit" disabled={!file || sending || job?.state === 'importing'}>{sending ? 'Uploading…' : 'Import file'}</button>
      <p className="admin-help">From the <a href="https://www.uscis.gov/tools/reports-and-studies/h-1b-employer-data-hub" target="_blank" rel="noreferrer">H-1B Employer Data Hub</a>: open Crosstab View, choose one complete fiscal year with no other filters, then Download → CSV. Each year in the file replaces that year here.</p>
      {message.text && <p className={`import-notice ${message.tone}`} role={message.tone === 'error' ? 'alert' : 'status'}>{message.text}</p>}
    </form>
  </section>;
}

function Summaries({ status }) {
  const { employers, identities, worksites, insights, profiles } = status;
  return <section className="site-status-card" aria-labelledby="site-summaries-heading">
    <header><div><h4 id="site-summaries-heading">Search and employer summaries</h4><p className="admin-help">Precomputed data used by search, insights and employer pages.</p></div></header>
    <div className="site-status-grid">
      <article><h5>Employer directory</h5>
        {employers ? <><Pill tone={employers.building ? 'active' : employers.ready ? 'success' : 'warning'}>{employers.building ? 'Building' : employers.ready ? 'Ready' : 'Not ready'}</Pill>
          <p>Updated {formatImportDate(employers.updatedAt)}</p>
          <ul>{['h1b', 'perm', 'pwd'].map(program => <li key={program}><span>{programLabel(program)}</span><span>{formatCount(employers.programs[program]?.employers)} names</span></li>)}</ul></>
          : <Pill tone="warning">Not built</Pill>}
      </article>
      <article><h5>Employer identities</h5>
        {identities ? <><Pill tone={identities.ready ? 'success' : 'warning'}>{identities.ready ? 'Ready' : 'Not ready'}</Pill>
          <p>Updated {formatImportDate(identities.updatedAt)}</p>
          <ul><li><span>Employers</span><span>{formatCount(identities.identities)}</span></li><li><span>Combined from several names</span><span>{formatCount(identities.combined)}</span></li><li><span>FEIN links</span><span>{formatCount(identities.feinLinks)}</span></li><li><span>USCIS tax-ID links</span><span>{formatCount(identities.taxIdLinks)}</span></li></ul></>
          : <Pill tone="warning">Not built</Pill>}
      </article>
      <article><h5>Worksite search</h5>
        <ul>{['h1b', 'perm', 'pwd'].map(program => <li key={program}><span>{programLabel(program)}</span><span><Pill tone={worksites[program]?.ready ? 'success' : 'warning'}>{worksites[program]?.ready ? 'Ready' : 'Preparing'}</Pill></span></li>)}</ul>
      </article>
      <article><h5>Search insights snapshots</h5>
        <ul>{insights.map(row => <li key={row.program}><span>{programLabel(row.program)}<small>{row.generatedAt ? formatImportDate(row.generatedAt) : 'No snapshot'}</small></span>
          <span><Pill tone={!row.generatedAt ? 'warning' : row.current ? 'success' : 'warning'}>{!row.generatedAt ? 'Missing' : row.current ? 'Current' : 'Stale'}</Pill></span></li>)}</ul>
      </article>
      <article><h5>Employer profiles</h5>
        <ul><li><span>Cached summaries</span><span>{formatCount(profiles.cached)}</span></li><li><span>Waiting to be computed</span><span>{formatCount(profiles.pending)}</span></li></ul>
        <p className="admin-help">Profiles refresh when visited after 24 hours; featured profiles refresh nightly.</p>
      </article>
    </div>
  </section>;
}

export default function SiteDataStatus() {
  const [status, setStatus] = useState(null);
  const [error, setError] = useState('');
  const [refreshing, setRefreshing] = useState(false);
  const load = useCallback(async () => {
    setRefreshing(true);
    try {
      const response = await fetch('/api/admin/site-status', { headers: { Authorization: `Bearer ${localStorage.getItem('adminToken')}` } });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || 'Unable to load site data status.');
      setStatus(data); setError('');
    } catch (failure) { setError(failure.message); }
    finally { setRefreshing(false); }
  }, []);
  useEffect(() => {
    const first = setTimeout(load, 0);
    const interval = setInterval(() => { if (document.visibilityState === 'visible') load(); }, 15000);
    return () => { clearTimeout(first); clearInterval(interval); };
  }, [load]);

  return <section className="site-data-status" aria-labelledby="site-data-heading">
    <div className="admin-section-heading"><div><h3 id="site-data-heading">Site data</h3><p className="admin-help">Background refreshes and the summaries they maintain. Updates every 15 seconds while open.</p></div>
      <button className="btn btn-secondary" onClick={load} disabled={refreshing}><FiRefreshCw className={refreshing ? 'is-refreshing' : ''} />{refreshing ? 'Refreshing…' : 'Refresh status'}</button>
    </div>
    {error && <p role="alert" className="import-notice error">{error} {status ? 'Showing the last loaded status.' : ''}</p>}
    {!status && !error ? <div className="admin-status-loading" role="status">Loading site data status…</div> : status && <>
      <RefreshRun refresh={status.refresh} />
      <MapBuilds rows={status.map} />
      <UscisData uscis={status.uscis} onImported={load} />
      <section className="site-status-card" aria-labelledby="site-i140-heading">
        <header><div><h4 id="site-i140-heading">USCIS I-140 statistics</h4><p className="admin-help">National I-140 counts behind <Link to="/i140">/i140</Link>. Checked weekly (Mondays, 4:15 AM Pacific) for a new USCIS quarter.</p></div>
          <Pill tone={status.i140 ? 'success' : 'warning'}>{status.i140 ? `FY${status.i140.fiscalYear} Q${status.i140.quarter}` : 'Not imported'}</Pill></header>
        {status.i140 && <><p className="admin-help">Imported {formatImportDate(status.i140.importedAt)}.</p>
          <ul className="site-status-sources">{status.i140.sources.map(source => <li key={source.name}>{source.url ? <a href={source.url} target="_blank" rel="noreferrer">{source.name}</a> : source.name}</li>)}</ul></>}
      </section>
      <Summaries status={status} />
      <p className="admin-help">Status as of {formatImportDate(status.generatedAt)}.</p>
    </>}
  </section>;
}
