import { useEffect, useId, useRef, useState } from 'react';
import { SERIES, compact, formatCount, formatRate, fyLabel, niceMax, seriesValues } from '../utils/uscisPresentation';

const HEIGHT = 250, TOP = 18, BOTTOM = 34, LEFT = 52;

function useWidth(fallback = 640) {
  const ref = useRef(null);
  const [width, setWidth] = useState(fallback);
  useEffect(() => {
    if (!ref.current || typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(([entry]) => setWidth(Math.max(280, Math.round(entry.contentRect.width))));
    observer.observe(ref.current);
    return () => observer.disconnect();
  }, []);
  return [ref, width];
}

// A bar's path: square at the baseline, 4px rounded data end.
const barPath = (x, y, width, height, round) => {
  if (height <= 0) return '';
  const r = round ? Math.min(4, width / 2, height) : 0;
  return `M${x},${y + height}V${y + r}${r ? `Q${x},${y} ${x + r},${y}` : ''}H${x + width - r}${r ? `Q${x + width},${y} ${x + width},${y + r}` : ''}V${y + height}Z`;
};

function Tooltip({ row, x, width }) {
  if (!row) return null;
  const values = seriesValues(row);
  const left = x + 250 <= width ? x + 14 : Math.max(0, x - 244);
  return <div className="uscis-tooltip" style={{ left }} role="presentation">
    <strong>{fyLabel(row.fiscalYear)}{row.partial ? ' · partial year' : ''}</strong>
    <dl>{SERIES.map(series => <div key={series.key}><dt><i className={`uscis-swatch is-${series.key}`} />{series.label}</dt>
      <dd>{formatCount(values[series.key].approvals)} approved<small>{formatCount(values[series.key].denials)} denied · {formatRate(values[series.key].rate)}</small></dd></div>)}</dl>
  </div>;
}

// Hit targets span each fiscal year's full column; selecting one filters the page.
function YearTargets({ rows, x, band, selected, onHover, onSelect, kind, chart }) {
  return rows.map(row => <a key={row.fiscalYear} href={`?fy=${row.fiscalYear}`} className="uscis-hit"
    aria-label={`${fyLabel(row.fiscalYear)}${row.partial ? ' (partial year)' : ''}: ${kind}. Select to show this fiscal year.`}
    onClick={event => { event.preventDefault(); onSelect(row.fiscalYear); }}
    onPointerEnter={event => { if (event.pointerType !== 'touch') onHover({ year: row.fiscalYear, chart }); }} onPointerLeave={() => onHover(null)}
    onFocus={() => onHover({ year: row.fiscalYear, chart })} onBlur={() => onHover(null)}>
    <rect x={x(row.fiscalYear) - band / 2} y={TOP} width={band} height={HEIGHT - TOP - BOTTOM} className={selected === row.fiscalYear ? 'is-selected' : undefined} />
  </a>);
}

function Axis({ width, max, format }) {
  const y = value => HEIGHT - BOTTOM - value / max * (HEIGHT - TOP - BOTTOM);
  return [0, max / 2, max].map(value => <g key={value} className="uscis-axis">
    <line x1={LEFT} x2={width - 8} y1={y(value)} y2={y(value)} /><text x={LEFT - 8} y={y(value) + 4} textAnchor="end">{format(value)}</text>
  </g>);
}

function YearLabels({ rows, x, band }) {
  const every = Math.max(1, Math.ceil(34 / band));
  return rows.map((row, index) => (index === rows.length - 1 || index % every === 0 && rows.length - 1 - index >= every)
    ? <text key={row.fiscalYear} className="uscis-year" x={x(row.fiscalYear)} y={HEIGHT - BOTTOM + 18} textAnchor="middle">{row.fiscalYear}{row.partial ? '*' : ''}</text> : null);
}

function Patterns({ id }) {
  return <defs>{SERIES.map(series => <pattern key={series.key} id={`${id}-${series.key}`} patternUnits="userSpaceOnUse" width="6" height="6" patternTransform="rotate(45)">
    <rect width="6" height="6" className="uscis-hatch-ground" /><line x1="0" y1="0" x2="0" y2="6" className={`uscis-hatch is-${series.key}`} />
  </pattern>)}</defs>;
}

export function ApprovalsChart({ rows, selected, hover, onHover, onSelect }) {
  const [ref, width] = useWidth();
  const id = useId().replace(/:/g, '');
  const band = (width - LEFT - 12) / Math.max(1, rows.length);
  const x = year => LEFT + (rows.findIndex(row => row.fiscalYear === year) + 0.5) * band;
  const max = niceMax(Math.max(0, ...rows.map(row => row.initialApprovals + row.continuingApprovals)));
  const scale = value => value / max * (HEIGHT - TOP - BOTTOM);
  const barWidth = Math.max(4, Math.min(30, band * 0.62));
  const hovered = rows.find(row => row.fiscalYear === hover?.year);
  return <figure className="uscis-figure">
    <figcaption><h3 id={`${id}-title`}>Approved workers by fiscal year</h3><p>Petitions USCIS approved on its first decision · stacked by petition type</p></figcaption>
    <div className="uscis-plot" ref={ref}>
      <svg viewBox={`0 0 ${width} ${HEIGHT}`} role="group" aria-labelledby={`${id}-title`}>
        <Patterns id={id} />
        <Axis width={width} max={max} format={compact} />
        {rows.map(row => {
          const left = x(row.fiscalYear) - barWidth / 2, base = HEIGHT - BOTTOM;
          const initial = scale(row.initialApprovals), continuing = scale(row.continuingApprovals);
          const gap = initial > 0 && continuing > 0 ? 2 : 0;
          return <g key={row.fiscalYear} className={selected && selected !== row.fiscalYear ? 'is-muted' : undefined}>
            <path className="uscis-bar is-initial" d={barPath(left, base - initial, barWidth, initial, continuing <= 0)} style={row.partial ? { fill: `url(#${id}-initial)` } : undefined} />
            <path className="uscis-bar is-continuing" d={barPath(left, base - initial - gap - continuing, barWidth, continuing, true)} style={row.partial ? { fill: `url(#${id}-continuing)` } : undefined} />
          </g>;
        })}
        <line className="uscis-baseline" x1={LEFT} x2={width - 8} y1={HEIGHT - BOTTOM} y2={HEIGHT - BOTTOM} />
        {hovered && <line className="uscis-crosshair" x1={x(hovered.fiscalYear)} x2={x(hovered.fiscalYear)} y1={TOP} y2={HEIGHT - BOTTOM} />}
        <YearLabels rows={rows} x={x} band={band} />
        <YearTargets rows={rows} x={x} band={band} selected={selected} onHover={onHover} onSelect={onSelect} kind="approved workers" chart="approvals" />
      </svg>
      <Tooltip row={hover?.chart === 'approvals' ? hovered : null} x={hovered ? x(hovered.fiscalYear) : 0} width={width} />
    </div>
  </figure>;
}

export function DenialRateChart({ rows, selected, hover, onHover, onSelect }) {
  const [ref, width] = useWidth();
  const id = useId().replace(/:/g, '');
  const right = 92; // Room for the line-end labels.
  const band = (width - LEFT - right) / Math.max(1, rows.length);
  const x = year => LEFT + (rows.findIndex(row => row.fiscalYear === year) + 0.5) * band;
  const rates = rows.map(seriesValues);
  const max = niceMax(Math.max(0.01, ...rates.flatMap(value => [value.initial.rate || 0, value.continuing.rate || 0])));
  const y = value => HEIGHT - BOTTOM - value / max * (HEIGHT - TOP - BOTTOM);
  const hovered = rows.find(row => row.fiscalYear === hover?.year);
  // Line-end labels sit at the last point, nudged apart when they would collide.
  const ends = SERIES.map(series => { const last = rates.findLast(value => value[series.key].rate !== null); return { series, y: last ? y(last[series.key].rate) : null }; });
  if (ends.every(end => end.y !== null) && Math.abs(ends[0].y - ends[1].y) < 16) {
    const middle = (ends[0].y + ends[1].y) / 2, upper = ends[0].y <= ends[1].y ? 0 : 1;
    ends[upper].y = middle - 8; ends[1 - upper].y = middle + 8;
  }
  return <figure className="uscis-figure">
    <figcaption><h3 id={`${id}-title`}>Denial rate by fiscal year</h3><p>Denied workers as a share of first decisions · zero-based scale</p></figcaption>
    <div className="uscis-plot" ref={ref}>
      <svg viewBox={`0 0 ${width} ${HEIGHT}`} role="group" aria-labelledby={`${id}-title`}>
        <Axis width={width - right + 8} max={max} format={value => formatRate(value)} />
        {SERIES.map(series => {
          const points = rows.map((row, index) => ({ row, rate: rates[index][series.key].rate })).filter(point => point.rate !== null);
          const solid = points.filter(point => !point.row.partial);
          const lastSolid = solid.at(-1), partial = points.filter(point => point.row.partial);
          return <g key={series.key}>
            <path className={`uscis-line is-${series.key}`} d={solid.map((point, index) => `${index ? 'L' : 'M'}${x(point.row.fiscalYear)},${y(point.rate)}`).join('')} />
            {lastSolid && partial.map(point => <path key={point.row.fiscalYear} className={`uscis-line is-${series.key} is-partial`} d={`M${x(lastSolid.row.fiscalYear)},${y(lastSolid.rate)}L${x(point.row.fiscalYear)},${y(point.rate)}`} />)}
            {points.map(point => <circle key={point.row.fiscalYear} className={`uscis-point is-${series.key}${point.row.partial ? ' is-partial' : ''}${selected && selected !== point.row.fiscalYear ? ' is-muted' : ''}`}
              cx={x(point.row.fiscalYear)} cy={y(point.rate)} r={hover?.year === point.row.fiscalYear || selected === point.row.fiscalYear ? 5 : 4} />)}
          </g>;
        })}
        {ends.map(({ series, y: labelY }) => labelY !== null && <g key={series.key} className="uscis-end-label">
          <circle className={`uscis-point is-${series.key}`} cx={width - right + 14} cy={labelY - 4} r="4" />
          <text x={width - right + 24} y={labelY}>{series.label}</text>
        </g>)}
        <line className="uscis-baseline" x1={LEFT} x2={width - right + 8} y1={HEIGHT - BOTTOM} y2={HEIGHT - BOTTOM} />
        {hovered && <line className="uscis-crosshair" x1={x(hovered.fiscalYear)} x2={x(hovered.fiscalYear)} y1={TOP} y2={HEIGHT - BOTTOM} />}
        <YearLabels rows={rows} x={x} band={band} />
        <YearTargets rows={rows} x={x} band={band} selected={selected} onHover={onHover} onSelect={onSelect} kind="denial rates" chart="rates" />
      </svg>
      <Tooltip row={hover?.chart === 'rates' ? hovered : null} x={hovered ? x(hovered.fiscalYear) : 0} width={width} />
    </div>
  </figure>;
}

export function TrendTable({ rows }) {
  return <details className="uscis-table-view"><summary>Show these numbers as a table</summary>
    <div className="uscis-table-scroll"><table>
      <caption className="sr-only">Approvals, denials and denial rates by fiscal year</caption>
      <thead><tr><th scope="col">Fiscal year</th><th scope="col">Initial approvals</th><th scope="col">Initial denials</th><th scope="col">Initial denial rate</th>
        <th scope="col">Continuing approvals</th><th scope="col">Continuing denials</th><th scope="col">Continuing denial rate</th></tr></thead>
      <tbody>{rows.map(row => { const values = seriesValues(row); return <tr key={row.fiscalYear}>
        <th scope="row">{fyLabel(row.fiscalYear)}{row.partial ? ' (partial)' : ''}</th>
        <td>{formatCount(row.initialApprovals)}</td><td>{formatCount(row.initialDenials)}</td><td>{formatRate(values.initial.rate)}</td>
        <td>{formatCount(row.continuingApprovals)}</td><td>{formatCount(row.continuingDenials)}</td><td>{formatRate(values.continuing.rate)}</td>
      </tr>; })}</tbody>
    </table></div>
  </details>;
}
