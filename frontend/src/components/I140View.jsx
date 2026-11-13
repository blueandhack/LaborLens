import { useEffect, useState, useSyncExternalStore } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { FiArrowRight, FiRefreshCw, FiStar } from 'react-icons/fi';
import { cachedJSON, getJSON } from '../utils/api';
import { PageSkeleton } from './Loading';
import { STATES } from '../utils/states';
import { compact, formatCount, formatRate } from '../utils/uscisPresentation';
import { CATEGORY_CODES, COMPARE_METRICS, INCOMPLETE_SHARE, MAX_COMPARE, SHORT_LABELS, awaitingColumns, backlogMonths, categorySummary, denialRate, formatMonths, levelOf,
  quarterLabel, quarterMonths, readI140State, suggestedCompare, titleCase, writeI140State } from '../utils/i140Presentation';
import { Legend, Lines, StackedColumns } from './StatCharts';
import { CompareChart, CompareCheck, Segmented } from './Compare';
import { browserStore } from '../utils/browserStore';
import YearRange from './YearRange';
import { inRange, normalizeRange } from '../utils/yearRange';
import './UscisView.css';
import './I140View.css';

const DECISIONS = [{ key: 'approved', label: 'Approved', tone: 'approved' }, { key: 'denied', label: 'Denied', tone: 'denied' }];
const OUTCOMES = [...DECISIONS, { key: 'pending', label: 'Pending or other', tone: 'pending' }];
const stateNames = new Set(STATES.map(([, name]) => name.toLowerCase()));
const Values = ({ rows }) => <dl>{rows.map(([label, value, tone]) => <div key={label}><dt>{tone && <i className={`stat-swatch tone-${tone}`} />}{label}</dt><dd>{value}</dd></div>)}</dl>;
const shortMonths = value => Number.isFinite(value) ? `${Math.round(value)} mo` : '—';
const signed = value => Number.isFinite(value) ? `${value > 0 ? '+' : value < 0 ? '−' : ''}${formatRate(Math.abs(value))}` : '—';

// The saved category lives in this browser; the prerendered page has none.
const savedStore = browserStore('i140Category');
const readSaved = () => { const value = savedStore.read(); return CATEGORY_CODES.includes(value) ? value : ''; };

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

// Every category side by side for one period, and up to four of them over time.
function Compare({ data, all, start, end, rangeIndexes, category, compare, suggested, metric, periodLabel, onChange }) {
  const series = compare.map((code, index) => ({ key: code, label: SHORT_LABELS[code], tone: `s${index + 1}` }));
  const names = Object.fromEntries(data.categories.map(item => [item.code, item.label]));
  const measure = COMPARE_METRICS.find(item => item.key === metric);
  const valueOf = (index, code) => {
    const values = all[index].categories[code] || {};
    return metric === 'rate' ? denialRate(values.approved || 0, values.denied || 0) : metric === 'backlog' ? backlogMonths(all, index, code) : values[metric] ?? null;
  };
  const format = measure.rate ? formatRate : measure.months ? shortMonths : formatCount;
  const rows = rangeIndexes.map(index => {
    const quarter = all[index];
    return { key: `${quarter.fiscalYear}-${quarter.quarter}`, label: quarterLabel(quarter.fiscalYear, quarter.quarter),
      title: `${quarterLabel(quarter.fiscalYear, quarter.quarter)} · ${quarterMonths(quarter.fiscalYear, quarter.quarter)}`, values: Object.fromEntries(compare.map(code => [code, valueOf(index, code)])) };
  });
  const toggle = code => onChange({ compare: compare.includes(code) ? compare.filter(item => item !== code) : [...compare, code] });
  return <section className="uscis-trends i140-compare" aria-labelledby="i140-compare">
    <h2 id="i140-compare" className="i140-section-title">Compare categories</h2>
    <p className="uscis-note">All categories for {periodLabel}. Tick up to {MAX_COMPARE} to chart them together; select a name to show it above.</p>
    <div className="uscis-table-scroll"><table className="uscis-employer-table compare-scorecard">
      <thead><tr><th scope="col" className="compare-check">Chart</th><th scope="col">Category</th><th scope="col">Received</th><th scope="col">vs. prior period</th><th scope="col">Approved</th><th scope="col">Denied</th>
        <th scope="col">Denial rate</th><th scope="col">Pending at end</th><th scope="col"><abbr title="Pending petitions ÷ average decided per quarter over the last four quarters">Backlog</abbr></th></tr></thead>
      <tbody>{data.categories.map(item => {
        const row = categorySummary(all, start, end, item.code);
        const sub = item.level !== item.code && item.code !== 'all';
        return <tr key={item.code} className={[item.code === category && 'is-selected', sub && 'is-sub', item.code === 'all' && 'is-total'].filter(Boolean).join(' ') || undefined}>
          <CompareCheck slot={compare.indexOf(item.code)} label={item.label} count={compare.length} onToggle={() => toggle(item.code)} />
          <th scope="row"><button type="button" className="compare-pick" aria-pressed={item.code === category} onClick={() => onChange({ category: item.code })}>{item.label}</button></th>
          <td>{formatCount(row.received)}</td>
          <td>{signed(row.receivedChange)}</td>
          <td>{formatCount(row.approved)}</td><td>{formatCount(row.denied)}</td>
          <td>{formatRate(row.rate)}{row.rateBefore !== null && <small>was {formatRate(row.rateBefore)}</small>}</td>
          <td>{formatCount(row.pending)}</td><td>{shortMonths(row.backlog)}</td>
        </tr>;
      })}</tbody>
    </table></div>
    <div className="compare-controls">
      <Segmented label="Measure to chart" options={COMPARE_METRICS} value={metric} onChange={key => onChange({ metric: key })} />
      {compare.join() !== suggested.join() && <button type="button" className="text-button" onClick={() => onChange({ compare: null })}>Reset to suggested</button>}
    </div>
    <CompareChart title={measure.title} firstColumn="Quarter" rows={rows} series={series} names={names} format={format}
      subtitle={measure.months ? 'Pending ÷ average decided per quarter over the last four quarters · zero-based scale' : measure.rate ? 'Denied ÷ (approved + denied) · zero-based scale' : 'Petitions (primary beneficiaries) · zero-based scale'}
      axisFormat={measure.rate ? value => `${Math.round(value * 100)}%` : measure.months ? value => compact(Math.round(value)) : compact} />
    <p className="uscis-note">Categories overlap: EB-2 includes NIW and the advanced-degree category, and “All categories” includes everything. Backlog is how long the pending petitions would take to decide at the recent pace, not a USCIS processing time; see <a href="https://egov.uscis.gov/processing-times/" target="_blank" rel="noreferrer">USCIS processing times</a> for those.</p>
  </section>;
}

export default function I140View() {
  const [params, setParams] = useSearchParams();
  const saved = useSyncExternalStore(savedStore.subscribe, readSaved, () => '');
  const state = readI140State(params, saved);
  const update = changes => setParams(writeI140State({ ...state, ...changes }, saved));
  // A saved category opens in the address too, so the link shares what is shown.
  useEffect(() => {
    if (saved && saved !== 'all' && !params.get('category')) setParams(writeI140State(readI140State(params, saved), saved), { replace: true });
  }, [saved, params, setParams]);
  // A kept or prefetched response shows on the first paint.
  const [response, setResponse] = useState(() => ({ data: cachedJSON('/api/i140') ?? null, error: null }));
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
    : <PageSkeleton label="Loading I-140 statistics…" controls={2} stats={4} chart rows={6} />}</article>;
  if (!data.available) return <article className="uscis-page">{intro}<div className="search-state"><h2>I-140 statistics are being prepared</h2><p>Please check back soon.</p></div></article>;

  const category = state.category, categoryLabel = data.categories.find(item => item.code === category)?.label;
  // The time range covers both views: quarters (FY2022 onward) and years filed (FY2012 onward).
  const years = [...new Set([...data.quarters.map(quarter => quarter.fiscalYear), ...data.cohorts.countries.flatMap(item => item.years)])].sort((a, b) => a - b);
  const range = normalizeRange(years, state.from, state.to);
  const rangeLabel = range.single ? `FY${range.from}` : `FY${range.from}–FY${range.to}`;
  const all = data.quarters;
  const rangeIndexes = all.map((quarter, index) => inRange(quarter.fiscalYear, range) ? index : -1).filter(index => index >= 0);
  const quarters = rangeIndexes.map(index => ({ ...all[index], index, values: all[index].categories[category] || {} }));
  const latest = quarters.at(-1), fiscalYear = latest?.fiscalYear;
  const sumOf = list => list.reduce((sum, quarter) => {
    for (const key of ['received', 'approved', 'denied']) sum[key] += quarter.values[key] || 0;
    return sum;
  }, { received: 0, approved: 0, denied: 0 });
  const yearToDate = sumOf(quarters.filter(quarter => quarter.fiscalYear === fiscalYear));
  const rangeTotals = sumOf(quarters);
  const latestBacklog = latest ? backlogMonths(all, latest.index, category) : null;
  const quarterRows = quarters.map(quarter => ({ key: `${quarter.fiscalYear}-${quarter.quarter}`, label: quarterLabel(quarter.fiscalYear, quarter.quarter),
    title: `${quarterLabel(quarter.fiscalYear, quarter.quarter)} · ${quarterMonths(quarter.fiscalYear, quarter.quarter)}`,
    values: { ...quarter.values, rate: denialRate(quarter.values.approved || 0, quarter.values.denied || 0), backlog: backlogMonths(all, quarter.index, category) } }));
  // The comparison covers the latest four quarters, or the whole range once one is chosen.
  const compareEnd = rangeIndexes.at(-1), compareStart = range.whole ? Math.max(0, compareEnd - 3) : rangeIndexes[0];
  const compareLabel = compareEnd === undefined ? '' : `${range.whole ? 'the latest four quarters, ' : ''}${quarterLabel(all[compareStart].fiscalYear, all[compareStart].quarter)} – ${quarterLabel(all[compareEnd].fiscalYear, all[compareEnd].quarter)}`;
  const suggested = suggestedCompare(category);
  const compare = state.compare?.length ? state.compare : suggested;

  const level = levelOf(data.categories, category);
  const levelLabel = data.categories.find(item => item.code === level)?.label;
  const isSub = level !== category && category !== 'all';
  const countries = data.cohorts.countries;
  const country = countries.find(item => item.name === state.country) || countries[0];
  const cohort = country.categories[level];
  const subApprovals = isSub ? country.approvals?.[category] : null;
  const cohortRows = country.years.map((year, index) => [year, index]).filter(([year]) => inRange(year, range)).map(([year, index]) => {
    const pending = cohort.pending[index], total = cohort.total[index] || cohort.approved[index] + cohort.denied[index] + pending;
    return { key: year, label: String(year), title: `Filed in FY${year}`, incomplete: total > 0 && pending / total > INCOMPLETE_SHARE,
      values: { approved: cohort.approved[index], denied: cohort.denied[index], pending, total, rate: denialRate(cohort.approved[index], cohort.denied[index]),
        sub: subApprovals?.[index] ?? null, share: subApprovals?.[index] != null && cohort.approved[index] ? subApprovals[index] / cohort.approved[index] : null } };
  });
  const subRows = cohortRows.some(row => Number.isFinite(row.values.sub)) ? cohortRows : [];
  const olderShown = (country.older || []).filter(item => inRange(item.year, range));
  const awaiting = data.awaiting;
  const awaitingTotal = awaiting.countries.find(row => row.name === 'Total');
  const awaitingMax = Math.max(1, ...awaiting.countries.filter(row => row.name !== 'Total').map(row => row.values.at(-1)));
  const focusColumns = awaitingColumns(awaiting.categories, category, level);
  const isSaved = saved === category;

  return <article className="uscis-page i140-page">
    {intro}
    <form className="uscis-controls" aria-label="I-140 category" onSubmit={event => event.preventDefault()}>
      <div className="i140-category">
        <label htmlFor="i140-category" className="uscis-industry">Preference category<select id="i140-category" className="search-input" value={category} onChange={event => update({ category: event.target.value })}>
          {data.categories.map(item => <option key={item.code} value={item.code}>{item.level !== item.code && item.code !== 'all' ? '— ' : ''}{item.label}</option>)}
        </select></label>
        {(category !== 'all' || saved) && <button type="button" className="compare-save" aria-pressed={isSaved} onClick={() => savedStore.write(isSaved || category === 'all' ? '' : category)}
          title={isSaved ? 'This page opens on this category in this browser. Select to stop.' : 'Open this page on this category next time, in this browser'}>
          <FiStar aria-hidden="true" />{isSaved ? 'My category' : 'Make my default'}</button>}
      </div>
      <YearRange years={years} from={state.from} to={state.to} onChange={changes => update(changes)} />
    </form>

    {!latest ? <section className="uscis-summary"><h2 id="i140-latest">{categoryLabel} · {rangeLabel}</h2>
      <p className="uscis-note">Quarterly figures start in FY{data.quarters[0].fiscalYear}. The charts of petitions by year filed below cover {rangeLabel}.</p></section>
    : !range.whole ? <section className="uscis-summary" aria-labelledby="i140-latest">
      <h2 id="i140-latest">{categoryLabel} · {rangeLabel} <small className="i140-range-note">({quarterLabel(quarters[0].fiscalYear, quarters[0].quarter)} – {quarterLabel(fiscalYear, latest.quarter)})</small></h2>
      <dl className="uscis-stats">
        <div className="uscis-stat"><dt>Received</dt><dd>{formatCount(rangeTotals.received)}</dd><small>in {quarters.length} {quarters.length === 1 ? 'quarter' : 'quarters'}</small></div>
        <div className="uscis-stat"><dt>Approved</dt><dd>{formatCount(rangeTotals.approved)}</dd><small>{formatCount(rangeTotals.denied)} denied</small></div>
        <div className="uscis-stat"><dt>Denial rate</dt><dd>{formatRate(denialRate(rangeTotals.approved, rangeTotals.denied))}</dd><small>of petitions decided in this range</small></div>
        <div className="uscis-stat"><dt>Pending</dt><dd>{formatCount(latest.values.pending)}</dd><small>at the end of {quarterLabel(fiscalYear, latest.quarter)} · backlog {formatMonths(latestBacklog)}</small></div>
      </dl>
      <p className="uscis-note">Decisions in a quarter can be on petitions filed earlier. Denial rate is denied ÷ (approved + denied). Backlog is the pending petitions ÷ the average decided per quarter over the last four quarters. USCIS fiscal years run October through September.</p>
    </section>
    : <section className="uscis-summary" aria-labelledby="i140-latest">
      <h2 id="i140-latest">{categoryLabel} · {quarterLabel(fiscalYear, latest.quarter)} ({quarterMonths(fiscalYear, latest.quarter)})</h2>
      <dl className="uscis-stats">
        <div className="uscis-stat"><dt>Received</dt><dd>{formatCount(latest.values.received)}</dd><small>{formatCount(yearToDate.received)} in FY{fiscalYear} so far</small></div>
        <div className="uscis-stat"><dt>Approved</dt><dd>{formatCount(latest.values.approved)}</dd><small>{formatCount(yearToDate.approved)} in FY{fiscalYear} so far</small></div>
        <div className="uscis-stat"><dt>Denial rate</dt><dd>{formatRate(denialRate(latest.values.approved, latest.values.denied))}</dd><small>{formatCount(latest.values.denied)} denied · {formatRate(denialRate(yearToDate.approved, yearToDate.denied))} in FY{fiscalYear}</small></div>
        <div className="uscis-stat"><dt>Pending</dt><dd>{formatCount(latest.values.pending)}</dd><small>backlog: {formatMonths(latestBacklog)} of decisions at the recent pace</small></div>
      </dl>
      <p className="uscis-note">Decisions in a quarter can be on petitions filed earlier. Denial rate is denied ÷ (approved + denied). Backlog is the pending petitions ÷ the average decided per quarter over the last four quarters. USCIS fiscal years run October through September.</p>
    </section>}

    {quarters.length > 0 && <section className="uscis-trends" aria-labelledby="i140-quarters">
      <h2 id="i140-quarters" className="i140-section-title">Decisions by quarter</h2>
      <Legend series={[...DECISIONS, { key: 'pending', label: 'Pending', tone: 'pending' }]} />
      <div className="uscis-charts">
        <StackedColumns title="Petitions decided" subtitle={`${categoryLabel} · approved and denied each quarter`} rows={quarterRows} series={DECISIONS}
          describe={row => `${row.title}: ${formatCount(row.values.approved)} approved, ${formatCount(row.values.denied)} denied`}
          tooltip={row => <Values rows={[['Received', formatCount(row.values.received)], ['Approved', formatCount(row.values.approved), 'approved'], ['Denied', formatCount(row.values.denied), 'denied'], ['Denial rate', formatRate(row.values.rate)], ['Pending at end', formatCount(row.values.pending), 'pending']]} />} />
        <Lines title="Pending at the end of each quarter" subtitle={`${categoryLabel} · petitions awaiting a decision`} rows={quarterRows} series={[{ key: 'pending', label: 'Pending', tone: 'pending' }]}
          describe={row => `${row.title}: ${formatCount(row.values.pending)} pending, backlog ${formatMonths(row.values.backlog)}`}
          tooltip={row => <Values rows={[['Pending', formatCount(row.values.pending), 'pending'], ['Received this quarter', formatCount(row.values.received)], ['Backlog', formatMonths(row.values.backlog)]]} />} />
      </div>
      <details className="uscis-table-view"><summary>Show these numbers as a table</summary><div className="uscis-table-scroll"><table>
        <thead><tr><th scope="col">Quarter</th><th scope="col">Received</th><th scope="col">Approved</th><th scope="col">Denied</th><th scope="col">Denial rate</th><th scope="col">Pending at end</th><th scope="col">Backlog</th></tr></thead>
        <tbody>{[...quarterRows].reverse().map(row => <tr key={row.key}><th scope="row">{row.title}</th><td>{formatCount(row.values.received)}</td><td>{formatCount(row.values.approved)}</td><td>{formatCount(row.values.denied)}</td><td>{formatRate(row.values.rate)}</td><td>{formatCount(row.values.pending)}</td><td>{shortMonths(row.values.backlog)}</td></tr>)}</tbody>
      </table></div></details>
    </section>}

    {rangeIndexes.length > 0 && <Compare data={data} all={all} start={compareStart} end={compareEnd} rangeIndexes={rangeIndexes} category={category} compare={compare} suggested={suggested}
      metric={state.metric} periodLabel={compareLabel} onChange={update} />}

    <section className="uscis-trends i140-cohorts" aria-labelledby="i140-cohorts">
      <header className="i140-section-head"><div><h2 id="i140-cohorts" className="i140-section-title">What happened to petitions filed each year</h2>
        <p className="uscis-note">Every petition filed in a fiscal year, by its status today ({cohortRows.length ? `FY${cohortRows[0].key}–FY${cohortRows.at(-1).key}` : rangeLabel}).{olderShown.length > 0 && ` ${olderShown.map(item => `FY${item.year}`).join(' and ')} ${olderShown.length === 1 ? 'comes' : 'come'} from earlier USCIS reports (${[...new Set(olderShown.map(item => item.source?.match(/FY(\d{4})/i)?.[1]).filter(Boolean))].map(year => `FY${year}`).join(', ')}) and ${olderShown.length === 1 ? 'shows its' : 'show their'} status then; nearly all had been decided.`} {level !== category ? `USCIS reports outcomes for each preference level, so the first two charts show all of ${levelLabel}${subRows.length ? `; the third shows ${SHORT_LABELS[category]} approvals, which USCIS does report on their own` : ''}.` : ''}</p></div>
        <label htmlFor="i140-country">Country of birth<select id="i140-country" className="search-input" value={country.name} onChange={event => update({ country: event.target.value === countries[0].name ? '' : event.target.value })}>
          {countries.map(item => <option key={item.name} value={item.name}>{item.name}</option>)}</select></label></header>
      <Legend series={OUTCOMES} extra={<li><i className="stat-swatch is-incomplete" aria-hidden="true" /><span>* Still being decided <small>(over 10% pending)</small></span></li>} />
      <div className="uscis-charts">
        <StackedColumns title="Petitions by year filed" subtitle={`${country.name} · ${level === 'all' ? '' : `${levelLabel} · `}current status of each year’s petitions`} rows={cohortRows} series={OUTCOMES}
          describe={row => `${row.title}: ${formatCount(row.values.approved)} approved, ${formatCount(row.values.denied)} denied, ${formatCount(row.values.pending)} pending`}
          tooltip={row => <><Values rows={[['Filed', formatCount(row.values.total)], ['Approved', formatCount(row.values.approved), 'approved'], ['Denied', formatCount(row.values.denied), 'denied'], ['Pending or other', formatCount(row.values.pending), 'pending'], ['Denial rate so far', formatRate(row.values.rate)]]} />{row.incomplete && <p>Many petitions are still pending; the rate can change.</p>}</>} />
        <Lines title="Denial rate by year filed" subtitle="Denied ÷ decided petitions · zero-based scale" rows={cohortRows} series={[{ key: 'rate', label: 'Denial rate', tone: 'denied' }]} format={value => formatRate(value)}
          describe={row => `${row.title}: ${formatRate(row.values.rate)} denied so far`}
          tooltip={row => <><Values rows={[['Denial rate', formatRate(row.values.rate), 'denied'], ['Decided', formatCount(row.values.approved + row.values.denied)], ['Pending or other', formatCount(row.values.pending)]]} />{row.incomplete && <p>Still being decided.</p>}</>} />
        {subRows.length > 0 && <Lines title={`${SHORT_LABELS[category]} approvals by year filed`} subtitle={`${country.name} · ${categoryLabel} petitions approved so far`} rows={subRows}
          series={[{ key: 'sub', label: 'Approved', tone: 'approved' }]}
          describe={row => `${row.title}: ${formatCount(row.values.sub)} ${SHORT_LABELS[category]} petitions approved, ${formatRate(row.values.share)} of ${SHORT_LABELS[level]} approvals`}
          tooltip={row => <><Values rows={[['Approved', formatCount(row.values.sub), 'approved'], [`Share of ${SHORT_LABELS[level]} approvals`, formatRate(row.values.share)]]} />{row.incomplete && <p>{SHORT_LABELS[level]} petitions from this year are still being decided.</p>}{!Number.isFinite(row.values.sub) && <p>Not reported separately for this year.</p>}</>} />}
      </div>
    </section>

    <section className="uscis-trends" aria-labelledby="i140-places">
      <h2 id="i140-places" className="i140-section-title">Where {category === 'all' ? '' : `${SHORT_LABELS[category]} `}petitions come from · {quarterLabel(data.latest.fiscalYear, data.latest.quarter)}</h2>{!range.whole && <p className="uscis-note">The latest quarter USCIS reports by state and country; the time range does not apply.</p>}
      <div className="i140-breakdowns">
        <Breakdown kind="state" title="By the worker’s state" rows={data.latest.states} category={category}
          note="The beneficiary’s U.S. state on the petition. Many EB-3 petitions are for workers abroad and have no state (Unknown)." />
        <Breakdown kind="country" title="By country of birth" rows={data.latest.countries} category={category}
          note="Green card limits apply per country of birth, which is why India and China have longer waits." />
      </div>
    </section>

    <section className="uscis-trends" aria-labelledby="i140-awaiting">
      <h2 id="i140-awaiting" className="i140-section-title">Approved petitions waiting for a visa · {awaiting.asOf}</h2>
      <p className="uscis-note">Approved employment-based petitions whose priority date is not yet current, so the worker cannot yet get a green card. {formatCount(awaitingTotal?.values.at(-1))} in total. Includes I-360 (4th preference) and I-526 (5th preference) petitions.{focusColumns.size > 0 && ` ${categoryLabel} petitions are counted in the highlighted ${focusColumns.size === 1 ? 'column' : 'columns'}.`}</p>
      <div className="uscis-table-scroll"><table className="uscis-employer-table i140-awaiting">
        <thead><tr><th scope="col">Country of birth</th>{awaiting.categories.map((label, index) => <th key={label} scope="col" className={focusColumns.has(index) ? 'is-focus' : undefined}>{label === 'TOTAL' ? 'Total' : label}</th>)}</tr></thead>
        <tbody>{awaiting.countries.filter(row => row.name !== 'Total').map(row => <tr key={row.name}><th scope="row">{row.name}<span className="i140-share" aria-hidden="true"><i style={{ '--share': row.values.at(-1) / awaitingMax }} /></span></th>
          {row.values.map((value, index) => <td key={index} className={focusColumns.has(index) ? 'is-focus' : undefined}>{formatCount(value)}</td>)}</tr>)}
          {awaitingTotal && <tr className="is-total"><th scope="row">Total</th>{awaitingTotal.values.map((value, index) => <td key={index} className={focusColumns.has(index) ? 'is-focus' : undefined}>{formatCount(value)}</td>)}</tr>}</tbody>
      </table></div>
    </section>

    <section className="uscis-method" aria-labelledby="i140-method">
      <h2 id="i140-method">What these numbers mean</h2>
      <ul>
        <li><strong>National counts only.</strong> USCIS does not publish I-140 data by employer, job or wage. Counts are petitions (primary beneficiaries), not family members.</li>
        <li><strong>Two views of the same petitions.</strong> “By quarter” counts what USCIS received and decided in each quarter, whenever the petition was filed. “By year filed” follows each fiscal year’s petitions to their current status; recent years are still being decided.</li>
        <li><strong>Backlog</strong> divides the petitions pending at a quarter’s end by the average number decided per quarter over the four quarters ending there. It shows how far behind USCIS is in a category, not how long any one petition takes: premium processing, requests for evidence and the order USCIS works in all change that.</li>
        <li><strong>Pending or other</strong> includes petitions awaiting a decision and a small number with other outcomes, such as withdrawals.</li>
        <li><strong>Categories.</strong> EB-1A, EB-2 national interest waiver and some EB-1B petitions can be self-filed; the other categories are filed by employers, and most EB-2 and EB-3 petitions require an approved PERM labor certification first.</li>
        <li><strong>Your category.</strong> “Make my default” keeps your category in this browser only, so the page opens on it next time.</li>
        <li><strong>Updates.</strong> USCIS revises earlier figures as cases are entered; LaborLens checks for a new quarter weekly. {compact(data.quarters.length)} quarters are available (FY{data.quarters[0].fiscalYear} onward); earlier quarterly reports are published only as PDFs.</li>
      </ul>
      <p>Sources: {[...data.sources, data.cohorts.source, data.awaiting.source].map((source, index) => <span key={source.name}>{index ? ' · ' : ''}{source.url ? <a href={source.url} target="_blank" rel="noreferrer">{source.name}</a> : source.name}</span>)} · <a href="https://www.uscis.gov/tools/reports-and-studies/immigration-and-citizenship-data" target="_blank" rel="noreferrer">USCIS Immigration and Citizenship Data</a> · <Link to="/data">Methodology <FiArrowRight aria-hidden="true" /></Link></p>
    </section>
  </article>;
}
