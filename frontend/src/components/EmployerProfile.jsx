import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { getJSON } from '../utils/api';
import { programs } from '../utils/programs';
import { presentCase } from '../utils/casePresentation';
import { applyPageSEO, getEmployerSEO } from '../utils/seo';
import NotFound from './NotFound';
import './Employers.css';

const number = value => Number(value || 0).toLocaleString('en-US');
const date = value => value ? new Date(value).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' }) : 'Not yet available';
const money = value => Number(value).toLocaleString('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 0, maximumFractionDigits: 2 });
const caseURL = (program, employer, extra = {}) => (program === 'pwd' ? '/' : '/' + program) + '?' + new URLSearchParams({ ...(employer.groupId ? { employerGroup: employer.groupId, company: employer.name } : { employer: employer.key }), ...extra });
const location = value => [value.city, value.state].filter(Boolean).join(', ') || 'Not reported';

function RankedNames({ title, rows, locations = false }) {
  return <section className="employer-ranked"><h3>{title}</h3><ol>{rows.map((row, index) => <li key={index}><span>{locations ? location(row._id) : row._id || 'Not reported'}</span><strong>{number(row.count)}</strong></li>)}</ol><p>Most common reported values · imported cases</p></section>;
}

function ProgramProfile({ employer, program, summary }) {
  const config = programs[program];
  const timeline = summary.timeline || [], peak = Math.max(1, ...timeline.map(row => row.count));
  const missingDates = summary.totalCount - timeline.reduce((sum, row) => sum + row.count, 0);
  return <section className="employer-program" id={program} aria-labelledby={'employer-program-' + program}>
    <header className="employer-program-heading"><div><p className="section-kicker">{config.wageLabel}</p><h2 id={'employer-program-' + program}>{config.label} filing history</h2><p><strong>{number(summary.totalCount)}</strong> imported {summary.totalCount === 1 ? 'case' : 'cases'} for {employer.groupId ? 'these combined filing names' : 'this reported name'}</p></div><Link className="btn btn-secondary" to={caseURL(program, employer)}>Browse {config.label} cases</Link></header>
    <div className="employer-program-grid">
      <section className="employer-history"><h3>{config.dateLabel} by calendar year</h3><p>{program === 'h1b' ? 'The last action can be a later withdrawal. This does not measure initial certification or processing time.' : 'Years reflect recorded case dates, rather than the source file’s fiscal year.'}</p>
        {timeline.length ? <ol className="employer-year-chart" aria-label={`${config.label} cases by calendar year`}>{timeline.map(row => <li key={row._id}><Link to={caseURL(program, employer, { [config.yearKey]: row._id })} aria-label={`${row._id}: ${number(row.count)} ${config.label} cases`}><span className="employer-year-count">{number(row.count)}</span><span className="employer-year-track" aria-hidden="true"><i style={{ '--share': row.count / peak }} /></span><strong>{row._id}</strong></Link></li>)}</ol> : <p>No usable case dates were reported.</p>}
        <p className="employer-chart-note">{number(missingDates)} cases without usable dates are excluded. Historical gaps can reflect missing disclosures; they do not establish that no applications existed.</p>
      </section>
      <section className="employer-wages"><h3>Reported wage ranges</h3><p>{config.wageLabel}. Pay periods stay separate; hourly rates are never converted to annual salaries.</p>
        {summary.wages.length ? <dl>{summary.wages.map((row, index) => <div key={index}><dt>{row._id || 'Pay period not reported'}</dt><dd><strong>{money(row.minimum)}{row.maximum !== row.minimum && ` – ${money(row.maximum)}`}</strong><small>{number(row.count)} cases with reported numeric wages</small></dd></div>)}</dl> : <p>No usable numeric wages were reported.</p>}
        <p>These are the minimum and maximum reported values, not typical pay, total compensation, or verified payroll amounts.</p>
      </section>
    </div>
    <div className="employer-breakdowns"><RankedNames title="Common job titles" rows={summary.jobs} /><RankedNames title="Employer addresses" rows={summary.employers} locations /><RankedNames title="Reported primary worksites" rows={summary.worksites} locations /></div>
    <details className="employer-statuses"><summary>Reported case statuses</summary><dl>{summary.statuses.map((row, index) => <div key={index}><dt>{row._id || 'Not reported'}</dt><dd>{number(row.count)}</dd></div>)}</dl><p>Statuses describe DOL applications. They do not establish USCIS visa or green card approvals.</p></details>
    <section className="employer-recent"><h3>Recent {config.label} records</h3><ul>{summary.recent.map(record => { const item = presentCase(record, program); return <li key={String(record._id)}><Link to={'/cases/' + record._id} state={{ from: '/employers/' + employer.slug }}><span><strong>{item.title}</strong><small>{record.CASE_NUMBER} · {item.status}</small></span><span>{item.wage === 'N/A' ? 'Wage not reported' : item.wage}</span><span>{date(item.eventDate)}</span></Link></li>; })}</ul></section>
    <details className="employer-sources"><summary>Original disclosure sources ({summary.sources.length}{summary.sources.length === 12 ? '+' : ''})</summary>{summary.sources.length ? <ul>{summary.sources.map(row => <li key={row._id}><a href={row._id} target="_blank" rel="noreferrer">{row.filename || new URL(row._id).pathname.split('/').pop()}</a><span>{number(row.count)} canonical cases in this snapshot</span></li>)}</ul> : <p>File provenance is unavailable for these older records. <a href="https://www.dol.gov/agencies/eta/foreign-labor/performance" target="_blank" rel="noreferrer">View official DOL disclosure releases.</a></p>}<p>These sources describe the current canonical records. They do not establish complete coverage of every historical quarter.</p></details>
  </section>;
}

export default function EmployerProfile({ initialProfile }) {
  const { slug } = useParams();
  const [attempt, setAttempt] = useState(0);
  const [response, setResponse] = useState(() => ({ slug: initialProfile?.slug, profile: initialProfile || null, error: null }));
  const profile = response.slug === slug ? response.profile : null;
  const error = response.slug === slug ? response.error : null;
  useEffect(() => {
    if (initialProfile?.slug === slug && initialProfile.ready && attempt === 0) return;
    const controller = new AbortController(); let timer, polls = 0;
    const load = () => getJSON('/api/employers/' + encodeURIComponent(slug), { signal: controller.signal })
      .then(data => {
        if (controller.signal.aborted) return;
        setResponse({ slug, profile: data, error: null });
        if (!data.ready && polls++ < 20) timer = setTimeout(load, 2000);
      })
      .catch(failure => { if (!controller.signal.aborted) setResponse({ slug, profile: null, error: failure.status === 404 ? 'missing' : 'Employer information could not load. Please try again.' }); });
    load(); return () => { controller.abort(); clearTimeout(timer); };
  }, [slug, initialProfile, attempt]);
  useEffect(() => { if (profile) applyPageSEO(getEmployerSEO(profile)); }, [profile]);
  if (error === 'missing') return <NotFound />;
  if (!profile) return <section className="employers-page"><Link to="/employers">← Employer directory</Link>{error ? <div className="search-state" role="alert"><h1>Employer information unavailable</h1><p>{error}</p><button className="btn" onClick={() => setAttempt(value => value + 1)}>Try again</button></div> : <div className="employer-loading" role="status">Loading employer profile…</div>}</section>;
  return <article className="employer-profile">
    <nav aria-label="Breadcrumb" className="employer-breadcrumb"><Link to="/employers">Employers</Link><span aria-hidden="true">/</span><span>{profile.name}</span></nav>
    <div className="employer-profile-top"><header className="employer-profile-heading"><p className="section-kicker">Reported employer · DOL disclosure history</p><h1>{profile.name}</h1><p>{profile.groupId ? 'Research this employer’s combined filing names across H-1B, PERM, and prevailing wage records.' : 'Research this reported name across H-1B, PERM, and prevailing wage records.'}</p><div className="employer-asof"><span>Source: U.S. Department of Labor</span><span>Snapshot: {date(profile.snapshotAt || profile.updatedAt)}</span></div></header>
    <dl className="employer-program-totals">{['h1b', 'perm', 'pwd'].map(program => <div key={program}><dt>{programs[program].label}</dt><dd>{number(profile.summaries[program]?.totalCount ?? profile.programs[program]?.count)}</dd><small>{(profile.summaries[program]?.totalCount ?? profile.programs[program]?.count) ? 'imported applications' : 'no imported matches'}</small></div>)}</dl>
    </div>{profile.groupId ? <aside className="employer-verified-names">
      <strong>Combined profile · {profile.reportedNames.length} reported filing names{profile.grouping.kind === 'reviewed' ? ' · reviewed' : ''}</strong>
      <p>{profile.grouping.description} Source names remain unchanged in every case.</p>
      <details><summary>Included names, counts, and matching evidence</summary>
        <ul className="employer-name-breakdown">{profile.reportedNames.map(member => <li key={member.id}><span className="employer-source-name">{member.name}<small>{member.location}</small></span><dl>{['h1b', 'perm', 'pwd'].map(program => <div key={program}><dt>{programs[program].label}</dt><dd>{member.programs[program]?.count ? <Link to={caseURL(program, member)} aria-label={`${number(member.programs[program].count)} ${programs[program].label} cases filed as ${member.name}`}>{number(member.programs[program].count)}</Link> : '0'}</dd></div>)}</dl></li>)}</ul>
        <p>{profile.grouping.reason}</p>{profile.grouping.evidence.length > 0 && <ul className="employer-group-evidence">{profile.grouping.evidence.map(item => <li key={item.url}>{item.url.startsWith('/') ? <Link to={item.url}>{item.title}</Link> : <a href={item.url} target="_blank" rel="noreferrer">{item.title}</a>}</li>)}</ul>}
        <p>{profile.grouping.policy}</p>
      </details>
    </aside> : <aside className="employer-identity-note"><strong>Profile matches this reported name exactly.</strong><details><summary>How names are grouped</summary><p>Capitalization, punctuation, spacing, and abbreviated corporate words (Corp./Corporation, Inc./Incorporated) are ignored, and names that report the same employer FEIN are combined. No other variant of this name was found. Identical reported names can belong to different legal entities; compare the case addresses and source disclosures. <Link to="/employers">Find another employer.</Link></p></details></aside>}
    {profile.similarNames?.length > 0 && <aside className="employer-similar"><h2>Similar employer names, kept separate</h2><ul>{profile.similarNames.map(item => <li key={item.id}><Link to={'/employers/' + item.slug}>{item.name}</Link><small> · {number(Object.values(item.programs).reduce((sum, info) => sum + info.count, 0))} imported cases</small></li>)}</ul><p>These are separate employers with similar names, not verified affiliations.</p></aside>}
    <nav className="employer-program-nav" aria-label="Employer programs">{['h1b', 'perm', 'pwd'].map(program => <a href={'#' + program} key={program}>{programs[program].label}<span>{number(profile.summaries[program]?.totalCount ?? profile.programs[program]?.count)}</span></a>)}</nav>
    {!profile.ready && <div className="inline-notice employer-summary-pending" role="status"><p>Detailed summaries are being prepared. You can browse this employer’s cases now.</p><button className="text-button" type="button" onClick={() => setAttempt(value => value + 1)}>Refresh summary</button></div>}
    {['h1b', 'perm', 'pwd'].map(program => profile.summaries[program] ? <ProgramProfile key={program} employer={profile} program={program} summary={profile.summaries[program]} /> : <section className="employer-program employer-program-empty" id={program} key={program}><h2>{programs[program].label} records</h2><p>{profile.programs[program]?.count ? 'A detailed summary for this program is being prepared.' : 'No cases for these filing names are currently listed in the imported data. Coverage is expanding, and a related company with a different name may file separately.'}</p><Link to={caseURL(program, profile)}>Search {programs[program].label} cases for {profile.groupId ? 'these names' : 'this name'}</Link></section>)}
    <footer className="employer-coverage-note"><strong>What this profile establishes</strong><p>These are imported DOL applications, not worker counts, visa approvals, current vacancies, or sponsorship promises. Wages retain their source pay periods. Historical coverage is expanding; an absent case or year is not proof that no filing existed. <Link to="/data">Sources, coverage, and methodology.</Link></p></footer>
  </article>;
}
