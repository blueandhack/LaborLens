import { Link } from 'react-router-dom';
import { USCIS_PATH, formatCount, formatRate, fyLabel, location, seriesValues, totalsOf } from '../utils/uscisPresentation';
import './UscisView.css';

const METHODS = { name: 'same name', abbreviation: 'abbreviations expanded', prefix: 'name cut short by USCIS' };

// USCIS first decisions on H-1B petitions filed under this employer's names.
export default function EmployerUscis({ uscis }) {
  if (!uscis?.years?.length) return null;
  const complete = uscis.years.filter(year => !year.partial);
  const totals = (complete.length ? complete : uscis.years).reduce((sum, year) => {
    for (const field of ['initialApprovals', 'initialDenials', 'continuingApprovals', 'continuingDenials']) sum[field] += year[field];
    return sum;
  }, { initialApprovals: 0, initialDenials: 0, continuingApprovals: 0, continuingDenials: 0 });
  const values = seriesValues(totals);
  const peak = Math.max(1, ...uscis.years.map(year => totalsOf(year).approvals));
  const search = uscis.names[0]?.name;
  return <section className="employer-program employer-uscis" id="uscis" aria-labelledby="employer-uscis-title">
    <header className="employer-program-heading"><div><p className="section-kicker">USCIS H-1B Employer Data Hub</p><h2 id="employer-uscis-title">H-1B petition decisions</h2>
      <p>Workers on H-1B petitions this employer filed, at USCIS’s first decision. Fiscal years run October through September.</p></div>
      {search && <Link className="btn btn-secondary" to={`${USCIS_PATH}?q=${encodeURIComponent(search)}`}>Compare petitioners</Link>}</header>
    <dl className="uscis-stats">
      <div className="uscis-stat"><dt>Initial approved</dt><dd>{formatCount(values.initial.approvals)}</dd><small>{formatCount(values.initial.denials)} denied</small></div>
      <div className="uscis-stat"><dt>Initial denial rate</dt><dd>{formatRate(values.initial.rate)}</dd><small>new and concurrent employment</small></div>
      <div className="uscis-stat"><dt>Continuing approved</dt><dd>{formatCount(values.continuing.approvals)}</dd><small>{formatCount(values.continuing.denials)} denied</small></div>
      <div className="uscis-stat"><dt>Continuing denial rate</dt><dd>{formatRate(values.continuing.rate)}</dd><small>extensions, transfers and amendments</small></div>
    </dl>
    {complete.length < uscis.years.length && <p className="uscis-note">Totals leave out {uscis.years.filter(year => year.partial).map(year => fyLabel(year.fiscalYear)).join(', ')}, a partial year.</p>}
    <div className="uscis-table-scroll"><table className="uscis-employer-table employer-uscis-years">
      <caption className="sr-only">USCIS decisions by fiscal year</caption>
      <thead><tr><th scope="col">Fiscal year</th><th scope="col">Approved workers</th><th scope="col">Initial approved</th><th scope="col">Initial denied</th><th scope="col">Continuing approved</th><th scope="col">Continuing denied</th><th scope="col">Denial rate</th></tr></thead>
      <tbody>{[...uscis.years].reverse().map(year => { const sums = totalsOf(year); return <tr key={year.fiscalYear}>
        <th scope="row">{fyLabel(year.fiscalYear)}{year.partial ? ' (partial)' : ''}</th>
        <td><span className="employer-uscis-bar" aria-hidden="true">{year.initialApprovals > 0 && <i className="is-initial" style={{ '--share': year.initialApprovals / peak }} />}{year.continuingApprovals > 0 && <i className="is-continuing" style={{ '--share': year.continuingApprovals / peak }} />}</span>{formatCount(sums.approvals)}</td>
        <td>{formatCount(year.initialApprovals)}</td><td>{formatCount(year.initialDenials)}</td><td>{formatCount(year.continuingApprovals)}</td><td>{formatCount(year.continuingDenials)}</td>
        <td>{formatRate(sums.denials / (sums.approvals + sums.denials || 1))}</td>
      </tr>; })}</tbody>
    </table></div>
    <details className="employer-sources"><summary>USCIS petitioner names matched to this profile ({uscis.names.length})</summary>
      <ul>{uscis.names.map(name => <li key={name.key}><span>{name.name}{location(name.location) && <small> · {location(name.location)}</small>}</span><span>{formatCount(name.decisions)} decisions · {METHODS[name.method] || name.method}</span></li>)}</ul>
      <p>USCIS reports the petitioner’s name, the last four digits of its tax ID and its mailing address. Names are matched to this employer’s filing names; a related company that files under another name is not included.</p>
    </details>
  </section>;
}
