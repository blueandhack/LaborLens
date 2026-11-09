import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { FiArrowRight, FiRefreshCw } from 'react-icons/fi';
import { getJSON } from '../utils/api';
import { STATES } from '../utils/states';
import { compact, formatCount, formatRate } from '../utils/uscisPresentation';
import { INCOMPLETE_SHARE, denialRate, levelOf, quarterLabel, quarterMonths, readI140State, titleCase, writeI140State } from '../utils/i140Presentation';
import { Legend, Lines, StackedColumns } from './StatCharts';
import './UscisView.css';
import './I140View.css';

const DECISIONS = [{ key: 'approved', label: 'Approved', tone: 'approved' }, { key: 'denied', label: 'Denied', tone: 'denied' }];
const OUTCOMES = [...DECISIONS, { key: 'pending', label: 'Pending or other', tone: 'pending' }];
const stateNames = new Set(STATES.map(([, name]) => name.toLowerCase()));
const Values = ({ rows }) => <dl>{rows.map(([label, value, tone]) => <div key={label}><dt>{tone && <i className={`stat-swatch tone-${tone}`} />}{label}</dt><dd>{value}</dd></div>)}</dl>;

function Breakdown({ title, note, rows, category, kind }) {
  const [open, setOpen] = useState(false);
  if (!rows?.receipts) return null;
  const approvals = new Map((rows.approvals || []).map(row => [row.name, row.values[category] ?? 0]));
  const total = rows.receipts.find(row => row.name === 'Total')?.values[category] || 0;
  const list = rows.receipts.filter(row => row.name !== 'Total').map(row => ({ name: row.name, receipts: row.values[category] ?? 0, approvals: approvals.get(row.name) ?? 0 }))
    .filter(row => row.receipts || row.approvals).sort((a, b) => (a.name === 'Unknown') - (b.name === 'Unknown') || b.receipts - a.receipts);
  const shown = open ? list : list.slice(0, 12);
  const largest = Math.max(1, ...list.map(row => row.receipts));
  const display = name => kind === 'country' ? titleCase(name) : name;
  return <section className="i140-breakdown" aria-labelledby={`i140-${kind}`}>
    <h3 id={`i140-${kind}`}>{title}</h3><p className="uscis-note">{note}</p>
    <div className="uscis-table-scroll"><table className="uscis-employer-table">
      <thead><tr><th scope="col">{kind === 'country' ? 'Country of birth' : 'Beneficiary state'}</th><th scope="col">Received</th><th scope="col">Share</th><th scope="col">Approved</th></tr></thead>
      <tbody>{shown.map(row => <tr key={row.name}><th scope="row">{display(row.name)}{kind === 'state' && !stateNames.has(row.name.toLowerCase()) && row.name !== 'Unknown' && <small>Territory or abroad</small>}</th>
        <td>{formatCount(row.receipts)}</td><td><span className="i140-share" aria-hidden="true"><i style={{ '--share': row.receipts / largest }} /></span>{formatRate(total ? row.receipts / total : null)}</td><td>{formatCount(row.approvals)}</td></tr>)}</tbody>
    </table></div>
    {list.length > 12 && <button type="button" className="text-button" onClick={() => setOpen(value => !value)}>{open ? 'Show fewer' : `Show all ${list.length}`}</button>}
  </section>;
}

export default function I140View() {
  const [params, setParams] = useSearchParams();
  const state = readI140State(params);
  const update = changes => setParams(writeI140State({ ...state, ...changes }));
  const [response, setResponse] = useState({ data: null, error: null });
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    getJSON('/api/i140', { signal: controller.signal }).then(data => setResponse({ data, error: null }))
      .catch(error => { if (!controller.signal.aborted) setResponse({ data: null, error: error.message || 'I-140 statistics could not load.' }); });
    return () => controller.abort();
  }, [retry]);

  const intro = <header className="uscis-intro">
    <p className="section-kicker">USCIS immigration data · Form I-140</p>
    <h1>I-140 employment-based green card petitions</h1>
    <p>Form I-140 is the petition an employer (or, for some categories, the worker) files with USCIS for an employment-based green card. These are USCIS’s national counts of petitions received, approved, denied and pending. USCIS does not publish I-140 decisions by employer; for employer records, see <Link to="/perm">PERM labor certifications</Link>, the step before most EB-2 and EB-3 petitions.</p>
  </header>;
  const { data, error } = response;
  if (!data) return <article className="uscis-page">{intro}{error ? <div className="search-state" role="alert"><p>{error}</p><button className="btn" type="button" onClick={() => setRetry(value => value + 1)}><FiRefreshCw aria-hidden="true" /> Try again</button></div>
    : <div className="employer-loading" role="status">Loading I-140 statistics…</div>}</article>;
  if (!data.available) return <article className="uscis-page">{intro}<div className="search-state"><h2>I-140 statistics are being prepared</h2><p>Please check back soon.</p></div></article>;

  const category = state.category, categoryLabel = data.categories.find(item => item.code === category)?.label;
  const quarters = data.quarters.map(quarter => ({ ...quarter, values: quarter.categories[category] || {} }));
  const latest = quarters.at(-1), fiscalYear = latest.fiscalYear;
  const yearToDate = quarters.filter(quarter => quarter.fiscalYear === fiscalYear).reduce((sum, quarter) => {
    for (const key of ['received', 'approved', 'denied']) sum[key] += quarter.values[key] || 0;
    return sum;
  }, { received: 0, approved: 0, denied: 0 });
  const quarterRows = quarters.map(quarter => ({ key: `${quarter.fiscalYear}-${quarter.quarter}`, label: quarterLabel(quarter.fiscalYear, quarter.quarter),
    title: `${quarterLabel(quarter.fiscalYear, quarter.quarter)} · ${quarterMonths(quarter.fiscalYear, quarter.quarter)}`, values: { ...quarter.values, rate: denialRate(quarter.values.approved || 0, quarter.values.denied || 0) } }));

  const level = levelOf(data.categories, category);
  const countries = data.cohorts.countries;
  const country = countries.find(item => item.name === state.country) || countries[0];
  const cohort = country.categories[level];
  const cohortRows = country.years.map((year, index) => {
    const pending = cohort.pending[index], total = cohort.total[index] || cohort.approved[index] + cohort.denied[index] + pending;
    return { key: year, label: String(year), title: `Filed in FY${year}`, incomplete: total > 0 && pending / total > INCOMPLETE_SHARE,
      values: { approved: cohort.approved[index], denied: cohort.denied[index], pending, total, rate: denialRate(cohort.approved[index], cohort.denied[index]) } };
  });
  const awaiting = data.awaiting;
  const awaitingTotal = awaiting.countries.find(row => row.name === 'Total');
  const awaitingMax = Math.max(1, ...awaiting.countries.filter(row => row.name !== 'Total').map(row => row.values.at(-1)));

  return <article className="uscis-page i140-page">
    {intro}
    <form className="uscis-controls" aria-label="I-140 category" onSubmit={event => event.preventDefault()}>
      <label htmlFor="i140-category" className="uscis-industry">Preference category<select id="i140-category" className="search-input" value={category} onChange={event => update({ category: event.target.value })}>
        {data.categories.map(item => <option key={item.code} value={item.code}>{item.level !== item.code && item.code !== 'all' ? '— ' : ''}{item.label}</option>)}
      </select></label>
    </form>

    <section className="uscis-summary" aria-labelledby="i140-latest">
      <h2 id="i140-latest">{categoryLabel} · {quarterLabel(fiscalYear, latest.quarter)} ({quarterMonths(fiscalYear, latest.quarter)})</h2>
      <dl className="uscis-stats">
        <div className="uscis-stat"><dt>Received</dt><dd>{formatCount(latest.values.received)}</dd><small>{formatCount(yearToDate.received)} in FY{fiscalYear} so far</small></div>
        <div className="uscis-stat"><dt>Approved</dt><dd>{formatCount(latest.values.approved)}</dd><small>{formatCount(yearToDate.approved)} in FY{fiscalYear} so far</small></div>
        <div className="uscis-stat"><dt>Denial rate</dt><dd>{formatRate(denialRate(latest.values.approved, latest.values.denied))}</dd><small>{formatCount(latest.values.denied)} denied · {formatRate(denialRate(yearToDate.approved, yearToDate.denied))} in FY{fiscalYear}</small></div>
        <div className="uscis-stat"><dt>Pending</dt><dd>{formatCount(latest.values.pending)}</dd><small>awaiting a decision at quarter end</small></div>
      </dl>
      <p className="uscis-note">Decisions in a quarter can be on petitions filed earlier. Denial rate is denied ÷ (approved + denied). USCIS fiscal years run October through September.</p>
    </section>

    <section className="uscis-trends" aria-labelledby="i140-quarters">
      <h2 id="i140-quarters" className="i140-section-title">Decisions by quarter</h2>
      <Legend series={[...DECISIONS, { key: 'pending', label: 'Pending', tone: 'pending' }]} />
      <div className="uscis-charts">
        <StackedColumns title="Petitions decided" subtitle={`${categoryLabel} · approved and denied each quarter`} rows={quarterRows} series={DECISIONS}
          describe={row => `${row.title}: ${formatCount(row.values.approved)} approved, ${formatCount(row.values.denied)} denied`}
          tooltip={row => <Values rows={[['Received', formatCount(row.values.received)], ['Approved', formatCount(row.values.approved), 'approved'], ['Denied', formatCount(row.values.denied), 'denied'], ['Denial rate', formatRate(row.values.rate)], ['Pending at end', formatCount(row.values.pending), 'pending']]} />} />
        <Lines title="Pending at the end of each quarter" subtitle={`${categoryLabel} · petitions awaiting a decision`} rows={quarterRows} series={[{ key: 'pending', label: 'Pending', tone: 'pending' }]}
          describe={row => `${row.title}: ${formatCount(row.values.pending)} pending`}
          tooltip={row => <Values rows={[['Pending', formatCount(row.values.pending), 'pending'], ['Received this quarter', formatCount(row.values.received)]]} />} />
      </div>
      <details className="uscis-table-view"><summary>Show these numbers as a table</summary><div className="uscis-table-scroll"><table>
        <thead><tr><th scope="col">Quarter</th><th scope="col">Received</th><th scope="col">Approved</th><th scope="col">Denied</th><th scope="col">Denial rate</th><th scope="col">Pending at end</th></tr></thead>
        <tbody>{[...quarterRows].reverse().map(row => <tr key={row.key}><th scope="row">{row.title}</th><td>{formatCount(row.values.received)}</td><td>{formatCount(row.values.approved)}</td><td>{formatCount(row.values.denied)}</td><td>{formatRate(row.values.rate)}</td><td>{formatCount(row.values.pending)}</td></tr>)}</tbody>
      </table></div></details>
    </section>

    <section className="uscis-trends i140-cohorts" aria-labelledby="i140-cohorts">
      <header className="i140-section-head"><div><h2 id="i140-cohorts" className="i140-section-title">What happened to petitions filed each year</h2>
        <p className="uscis-note">Every petition filed in a fiscal year, by its status today (FY{country.years[0]}–FY{country.years.at(-1)}).{country.older?.length > 0 && ` ${country.older.map(item => `FY${item.year}`).join(' and ')} come from earlier USCIS reports (${[...new Set(country.older.map(item => item.source?.match(/FY(\d{4})/i)?.[1]).filter(Boolean))].map(year => `FY${year}`).join(', ')}) and show their status then; nearly all had been decided.`} {level !== category ? `USCIS reports this for each preference level, so this shows all of ${data.categories.find(item => item.code === level)?.label}.` : ''}</p></div>
        <label htmlFor="i140-country">Country of birth<select id="i140-country" className="search-input" value={country.name} onChange={event => update({ country: event.target.value === countries[0].name ? '' : event.target.value })}>
          {countries.map(item => <option key={item.name} value={item.name}>{item.name}</option>)}</select></label></header>
      <Legend series={OUTCOMES} extra={<li><i className="stat-swatch is-incomplete" aria-hidden="true" /><span>* Still being decided <small>(over 10% pending)</small></span></li>} />
      <div className="uscis-charts">
        <StackedColumns title="Petitions by year filed" subtitle={`${country.name} · current status of each year’s petitions`} rows={cohortRows} series={OUTCOMES}
          describe={row => `${row.title}: ${formatCount(row.values.approved)} approved, ${formatCount(row.values.denied)} denied, ${formatCount(row.values.pending)} pending`}
          tooltip={row => <><Values rows={[['Filed', formatCount(row.values.total)], ['Approved', formatCount(row.values.approved), 'approved'], ['Denied', formatCount(row.values.denied), 'denied'], ['Pending or other', formatCount(row.values.pending), 'pending'], ['Denial rate so far', formatRate(row.values.rate)]]} />{row.incomplete && <p>Many petitions are still pending; the rate can change.</p>}</>} />
        <Lines title="Denial rate by year filed" subtitle="Denied ÷ decided petitions · zero-based scale" rows={cohortRows} series={[{ key: 'rate', label: 'Denial rate', tone: 'denied' }]} format={value => formatRate(value)}
          describe={row => `${row.title}: ${formatRate(row.values.rate)} denied so far`}
          tooltip={row => <><Values rows={[['Denial rate', formatRate(row.values.rate), 'denied'], ['Decided', formatCount(row.values.approved + row.values.denied)], ['Pending or other', formatCount(row.values.pending)]]} />{row.incomplete && <p>Still being decided.</p>}</>} />
      </div>
    </section>

    <section className="uscis-trends" aria-labelledby="i140-places">
      <h2 id="i140-places" className="i140-section-title">Where petitions come from · {quarterLabel(fiscalYear, latest.quarter)}</h2>
      <div className="i140-breakdowns">
        <Breakdown kind="state" title="By the worker’s state" rows={data.latest.states} category={category}
          note="The beneficiary’s U.S. state on the petition. Many EB-3 petitions are for workers abroad and have no state (Unknown)." />
        <Breakdown kind="country" title="By country of birth" rows={data.latest.countries} category={category}
          note="Green card limits apply per country of birth, which is why India and China have longer waits." />
      </div>
    </section>

    <section className="uscis-trends" aria-labelledby="i140-awaiting">
      <h2 id="i140-awaiting" className="i140-section-title">Approved petitions waiting for a visa · {awaiting.asOf}</h2>
      <p className="uscis-note">Approved employment-based petitions whose priority date is not yet current, so the worker cannot yet get a green card. {formatCount(awaitingTotal?.values.at(-1))} in total. Includes I-360 (4th preference) and I-526 (5th preference) petitions.</p>
      <div className="uscis-table-scroll"><table className="uscis-employer-table i140-awaiting">
        <thead><tr><th scope="col">Country of birth</th>{awaiting.categories.map(label => <th key={label} scope="col">{label === 'TOTAL' ? 'Total' : label}</th>)}</tr></thead>
        <tbody>{awaiting.countries.filter(row => row.name !== 'Total').map(row => <tr key={row.name}><th scope="row">{row.name}<span className="i140-share" aria-hidden="true"><i style={{ '--share': row.values.at(-1) / awaitingMax }} /></span></th>
          {row.values.map((value, index) => <td key={index}>{formatCount(value)}</td>)}</tr>)}
          {awaitingTotal && <tr className="is-total"><th scope="row">Total</th>{awaitingTotal.values.map((value, index) => <td key={index}>{formatCount(value)}</td>)}</tr>}</tbody>
      </table></div>
    </section>

    <section className="uscis-method" aria-labelledby="i140-method">
      <h2 id="i140-method">What these numbers mean</h2>
      <ul>
        <li><strong>National counts only.</strong> USCIS does not publish I-140 data by employer, job or wage. Counts are petitions (primary beneficiaries), not family members.</li>
        <li><strong>Two views of the same petitions.</strong> “By quarter” counts what USCIS received and decided in each quarter, whenever the petition was filed. “By year filed” follows each fiscal year’s petitions to their current status; recent years are still being decided.</li>
        <li><strong>Pending or other</strong> includes petitions awaiting a decision and a small number with other outcomes, such as withdrawals.</li>
        <li><strong>Categories.</strong> EB-1A, EB-2 national interest waiver and some EB-1B petitions can be self-filed; the other categories are filed by employers, and most EB-2 and EB-3 petitions require an approved PERM labor certification first.</li>
        <li><strong>Updates.</strong> USCIS revises earlier figures as cases are entered; LaborLens checks for a new quarter weekly. {compact(data.quarters.length)} quarters are shown (FY{data.quarters[0].fiscalYear} onward); earlier quarterly reports are published only as PDFs.</li>
      </ul>
      <p>Sources: {[...data.sources, data.cohorts.source, data.awaiting.source].map((source, index) => <span key={source.name}>{index ? ' · ' : ''}{source.url ? <a href={source.url} target="_blank" rel="noreferrer">{source.name}</a> : source.name}</span>)} · <a href="https://www.uscis.gov/tools/reports-and-studies/immigration-and-citizenship-data" target="_blank" rel="noreferrer">USCIS Immigration and Citizenship Data</a> · <Link to="/data">Methodology <FiArrowRight aria-hidden="true" /></Link></p>
    </section>
  </article>;
}
