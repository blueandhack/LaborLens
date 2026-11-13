import { Legend, Lines } from './StatCharts';
import './Compare.css';

// Pieces shared by the statistics pages' "compare" sections: up to four series,
// each in a fixed color slot (tone-s1…s4) by its position in the list.
export const MAX_COMPARE = 4;

const Values = ({ rows }) => <dl>{rows.map(([label, value, tone]) => <div key={label}><dt>{tone && <i className={`stat-swatch tone-${tone}`} />}{label}</dt><dd>{value}</dd></div>)}</dl>;

// A table cell with the "chart this" checkbox and its color. keepOne stops the last series being removed.
export function CompareCheck({ slot, label, count, onToggle, keepOne = true }) {
  const checked = slot >= 0;
  return <td className="compare-check"><label>
    <input type="checkbox" checked={checked} disabled={checked ? keepOne && count === 1 : count >= MAX_COMPARE} onChange={onToggle} aria-label={`Chart ${label}`} />
    <i className={`stat-swatch${checked ? ` tone-s${slot + 1}` : ' is-empty'}`} aria-hidden="true" />
  </label></td>;
}

export function Segmented({ label, options, value, onChange }) {
  return <div className="year-range-presets compare-segmented" role="group" aria-label={label}>
    {options.map(option => <button key={option.key} type="button" aria-pressed={option.key === value} onClick={() => onChange(option.key)}>{option.label}</button>)}
  </div>;
}

// The chosen series over time, with a legend (full names), direct labels (short
// names) and the same numbers as a table, since some slots are low-contrast.
export function CompareChart({ title, subtitle, rows, series, names, format, axisFormat, firstColumn = 'Year' }) {
  const legend = series.map(item => ({ ...item, label: names?.[item.key] || item.label }));
  return <>
    <Legend series={legend} />
    {rows.length > 0 && <div className="compare-chart">
      <Lines title={title} subtitle={subtitle} rows={rows} series={series} format={axisFormat}
        describe={row => `${row.title || row.label}: ${series.map(item => `${item.label} ${format(row.values[item.key])}`).join(', ')}`}
        tooltip={row => <><Values rows={series.map(item => [item.label, format(row.values[item.key]), item.tone])} />{row.note && <p>{row.note}</p>}</>} />
    </div>}
    <details className="uscis-table-view"><summary>Show the chart as a table</summary><div className="uscis-table-scroll"><table>
      <thead><tr><th scope="col">{firstColumn}</th>{series.map(item => <th key={item.key} scope="col">{names?.[item.key] || item.label}</th>)}</tr></thead>
      <tbody>{[...rows].reverse().map(row => <tr key={row.key}><th scope="row">{row.title || row.label}</th>{series.map(item => <td key={item.key}>{format(row.values[item.key])}</td>)}</tr>)}</tbody>
    </table></div></details>
  </>;
}
