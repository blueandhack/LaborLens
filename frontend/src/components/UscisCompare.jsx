import { useState } from 'react';
import { Link } from 'react-router-dom';
import { stateName } from '../utils/states';
import { COMPARE_BY, INDUSTRY_SHORT, MIN_RATE_DECISIONS, USCIS_METRICS, compact, countedYears, formatCount, formatRate, fyLabel, groupSummary, location, priorYears,
  sumYears, titleCase, uscisBreakdownURL, uscisCompareURL } from '../utils/uscisPresentation';
import { useJSON } from '../utils/useJSON';
import { CompareChart, CompareCheck, MAX_COMPARE, Segmented } from './Compare';

const FAILURE = 'These comparisons could not load. Please try again.';
const SHOWN = 15;
const signed = value => Number.isFinite(value) ? `${value > 0 ? '+' : value < 0 ? '−' : ''}${formatRate(Math.abs(value))}` : '—';
const shortName = name => { const text = titleCase(name); return text.length > 15 ? `${text.slice(0, 14).trimEnd()}…` : text; };
const LIST_KEY = { industry: 'industries', state: 'states', employer: 'employers' };

// Industries, states or chosen petitioners side by side for the selected years,
// and up to four of them charted by year.
export default function UscisCompare({ data, state, range, onChange, onFilter, petitioners }) {
  const by = state.by, listKey = LIST_KEY[by];
  const breakdown = useJSON(by === 'employer' ? null : uscisBreakdownURL(state), FAILURE);
  const compared = useJSON(by === 'employer' && state.employers.length ? uscisCompareURL(state.employers) : null, FAILURE);
  const [open, setOpen] = useState(false);
  const response = by === 'employer' ? compared : breakdown;

  const years = data.years;
  const counted = countedYears(years, range.from, range.to), prior = priorYears(years, counted);
  const periodLabel = !counted.length ? '' : counted.length === 1 ? fyLabel(counted[0]) : `${fyLabel(counted[0])}–${fyLabel(counted.at(-1))}`;
  const industryName = code => data.industries.find(item => item.code === code)?.label || code;
  const groups = by === 'employer'
    ? (compared.data?.employers || []).map(row => ({ key: row.key, name: row.name, short: shortName(row.name), rows: row.years, profile: row.profile,
      detail: [location(row.location), row.industry && industryName(row.industry)].filter(Boolean).join(' · ') }))
    : (breakdown.data?.groups || []).map(group => ({ key: group.code, name: by === 'industry' ? industryName(group.code) : stateName(group.code),
      short: by === 'industry' ? INDUSTRY_SHORT[group.code] || group.code : group.code, detail: by === 'industry' ? `NAICS ${group.code}` : '', rows: group.years }));
  const summaries = groups.map(group => ({ ...group, summary: groupSummary(group.rows, counted, prior) }))
    .filter(group => by === 'employer' || group.summary.approvals + group.summary.denials > 0);
  if (by !== 'employer') summaries.sort((a, b) => b.summary.approvals - a.summary.approvals);
  const known = new Set(summaries.map(group => group.key));

  // The page's own state or industry filter leads the suggestions, then the largest.
  const filterCode = by === 'industry' ? state.industry : by === 'state' ? state.state : '';
  const suggested = [...new Set([filterCode, ...summaries.map(group => group.key)])].filter(key => key && known.has(key)).slice(0, 3);
  const asked = state[listKey].filter(key => known.has(key));
  const chosen = by === 'employer' ? asked : asked.length ? asked : suggested;
  const toggle = key => onChange({ [listKey]: chosen.includes(key) ? chosen.filter(item => item !== key) : [...chosen, key] });

  const byKey = new Map(summaries.map(group => [group.key, group]));
  const series = chosen.map((key, index) => ({ key, label: byKey.get(key).short, tone: `s${index + 1}` }));
  const names = Object.fromEntries(chosen.map(key => [key, byKey.get(key).name]));
  const measure = USCIS_METRICS.find(item => item.key === state.metric);
  const partial = new Map(years.filter(year => year.partial).map(year => [year.fiscalYear, year.note || 'Partial year.']));
  const rows = years.filter(year => range.single || year.fiscalYear >= range.from && year.fiscalYear <= range.to).map(({ fiscalYear }) => ({
    key: fiscalYear, label: fyLabel(fiscalYear), title: `${fyLabel(fiscalYear)}${partial.has(fiscalYear) ? ' (partial year)' : ''}`, incomplete: partial.has(fiscalYear), note: partial.get(fiscalYear),
    values: Object.fromEntries(chosen.map(key => [key, sumYears(byKey.get(key).rows, [fiscalYear])[state.metric]])) }));

  const filterOf = key => by === 'industry' ? { industry: key } : { state: key };
  const shown = by === 'employer' || open ? summaries : summaries.filter((group, index) => index < SHOWN || chosen.includes(group.key) || group.key === filterCode);
  const scope = by === 'industry' ? (state.state ? ` in ${stateName(state.state)}` : '') : by === 'state' ? (state.industry ? ` in ${industryName(state.industry)}` : '') : '';
  const top = (petitioners || []).slice(0, 3).map(row => row.key);

  return <section className="uscis-trends uscis-compare" id="uscis-compare" aria-labelledby="uscis-compare-title">
    <h2 id="uscis-compare-title" className="uscis-compare-title">Compare</h2>
    <div className="compare-controls">
      <Segmented label="Compare" options={COMPARE_BY} value={by} onChange={key => onChange({ by: key })} />
    </div>
    <p className="uscis-note">{by === 'employer'
      ? `Petitioners you choose, for ${periodLabel}. Tick up to ${MAX_COMPARE} in the Petitioners table below.`
      : `Every ${by === 'industry' ? 'industry' : 'petitioner state'}${scope} for ${periodLabel}, most approvals first. Tick up to ${MAX_COMPARE} to chart them together; select a name to filter the page to it.`}
      {' '}Denial rates need at least {MIN_RATE_DECISIONS} decisions.</p>

    {response.error ? <div className="search-state" role="alert"><p>{response.error}</p><button className="btn" type="button" onClick={response.retry}>Try again</button></div>
      : by === 'employer' && !state.employers.length ? <p className="compare-empty">No petitioners chosen yet.
        {top.length > 0 && <button type="button" className="btn btn-secondary" onClick={() => onChange({ employers: top })}>Compare the top {top.length} in the table</button>}</p>
      : !response.data ? <p className="uscis-note" aria-busy="true">Loading…</p>
      : <div className={response.loading ? 'is-loading' : undefined} aria-busy={response.loading}>
        <div className="uscis-table-scroll"><table className="uscis-employer-table compare-scorecard">
          <thead><tr><th scope="col" className="compare-check">Chart</th><th scope="col">{by === 'industry' ? 'Industry' : by === 'state' ? 'State' : 'Petitioner'}</th>
            <th scope="col">Initial approved</th><th scope="col">Initial denial rate</th><th scope="col">Continuing approved</th><th scope="col">Continuing denial rate</th>
            <th scope="col">All approved</th>{prior && <th scope="col"><abbr title={`Change in approvals from ${fyLabel(prior[0])}${prior.length > 1 ? `–${fyLabel(prior.at(-1))}` : ''}`}>vs. prior period</abbr></th>}</tr></thead>
          <tbody>{shown.map(group => <tr key={group.key} className={group.key === filterCode ? 'is-selected' : undefined}>
            <CompareCheck slot={chosen.indexOf(group.key)} label={group.name} count={chosen.length} keepOne={by !== 'employer'} onToggle={() => toggle(group.key)} />
            <th scope="row">{by === 'employer'
              ? <span className="uscis-employer-name">{group.profile ? <Link to={'/employers/' + group.profile}>{group.name}</Link> : group.name}</span>
              : <button type="button" className="compare-pick" aria-pressed={group.key === filterCode} onClick={() => onFilter(filterOf(group.key === filterCode ? '' : group.key))}>{group.name}</button>}
              {group.detail && <small>{group.detail}</small>}</th>
            <td>{formatCount(group.summary.initialApprovals)}</td><td>{formatRate(group.summary.initialRate)}</td>
            <td>{formatCount(group.summary.continuingApprovals)}</td><td>{formatRate(group.summary.continuingRate)}</td>
            <td>{formatCount(group.summary.approvals)}</td>{prior && <td>{signed(group.summary.change)}</td>}
          </tr>)}</tbody>
        </table></div>
        {shown.length < summaries.length && <button type="button" className="text-button compare-more" onClick={() => setOpen(true)}>Show all {summaries.length}</button>}
        {open && by !== 'employer' && summaries.length > SHOWN && <button type="button" className="text-button compare-more" onClick={() => setOpen(false)}>Show fewer</button>}
        {chosen.length > 0 && <>
          <div className="compare-controls">
            <Segmented label="Measure to chart" options={USCIS_METRICS} value={state.metric} onChange={key => onChange({ metric: key })} />
            {by !== 'employer' && state[listKey].length > 0 && <button type="button" className="text-button" onClick={() => onChange({ [listKey]: [] })}>Reset to suggested</button>}
          </div>
          <CompareChart title={measure.title} firstColumn="Fiscal year" rows={rows} series={series} names={names} format={measure.rate ? formatRate : formatCount}
            subtitle={measure.rate ? `Denied ÷ decided, shown with ${MIN_RATE_DECISIONS}+ decisions in the year · zero-based scale` : 'Workers on approved petitions · zero-based scale'}
            axisFormat={measure.rate ? value => `${Math.round(value * 1000) / 10}%` : compact} />
        </>}
      </div>}
    {by === 'employer' && <p className="uscis-note">Each petitioner combines the spellings of its name; a company that files under several names can appear more than once.</p>}
  </section>;
}
