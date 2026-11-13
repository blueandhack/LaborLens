import { useEffect, useId, useRef, useState } from 'react';
import { compact, niceMax } from '../utils/uscisPresentation';
import './StatCharts.css';

// Generic stacked columns and lines for statistics pages. Rows are
// { key, label, values: { [series]: number }, muted?, incomplete? }; series are
// { key, label, tone } where tone picks a categorical color (approved, denied, pending).
const HEIGHT = 240, TOP = 16, BOTTOM = 34, LEFT = 52;

function useWidth() {
  const ref = useRef(null);
  const [width, setWidth] = useState(640);
  useEffect(() => {
    if (!ref.current || typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(([entry]) => setWidth(Math.max(280, Math.round(entry.contentRect.width))));
    observer.observe(ref.current);
    return () => observer.disconnect();
  }, []);
  return [ref, width];
}

const columnPath = (x, y, width, height, round) => {
  if (height <= 0) return '';
  const r = round ? Math.min(4, width / 2, height) : 0;
  return `M${x},${y + height}V${y + r}${r ? `Q${x},${y} ${x + r},${y}` : ''}H${x + width - r}${r ? `Q${x + width},${y} ${x + width},${y + r}` : ''}V${y + height}Z`;
};

function Frame({ title, subtitle, children, plotRef, tooltip }) {
  const id = useId();
  return <figure className="stat-figure">
    <figcaption><h3 id={id}>{title}</h3>{subtitle && <p>{subtitle}</p>}</figcaption>
    <div className="stat-plot" ref={plotRef} role="group" aria-labelledby={id}>{children}{tooltip}</div>
  </figure>;
}

function Axis({ width, right, max, format }) {
  const y = value => HEIGHT - BOTTOM - value / max * (HEIGHT - TOP - BOTTOM);
  return [0, max / 2, max].map(value => <g key={value} className="stat-axis">
    <line x1={LEFT} x2={width - right} y1={y(value)} y2={y(value)} /><text x={LEFT - 8} y={y(value) + 4} textAnchor="end">{format(value)}</text>
  </g>);
}

function Labels({ rows, x, band }) {
  // About 7px per monospace character, plus a gap between labels.
  const widest = Math.max(4, ...rows.map(row => String(row.label).length + (row.incomplete ? 1 : 0)));
  const every = Math.max(1, Math.ceil((widest * 7 + 12) / band));
  return rows.map((row, index) => (index === rows.length - 1 || index % every === 0 && rows.length - 1 - index >= every)
    ? <text key={row.key} className="stat-label" x={x(index)} y={HEIGHT - BOTTOM + 18} textAnchor="middle">{row.label}{row.incomplete ? '*' : ''}</text> : null);
}

// Full-height hit targets; hovering or focusing one shows its tooltip.
function Targets({ rows, x, band, setHover, describe }) {
  return rows.map((row, index) => <g key={row.key} className="stat-hit" tabIndex={0} role="img" aria-label={describe(row)}
    onPointerEnter={event => { if (event.pointerType !== 'touch') setHover(index); }} onPointerLeave={() => setHover(null)}
    onFocus={() => setHover(index)} onBlur={() => setHover(null)} onClick={() => setHover(index)}>
    <rect x={x(index) - band / 2} y={TOP} width={band} height={HEIGHT - TOP - BOTTOM} />
  </g>);
}

function Tooltip({ row, x, width, children }) {
  if (!row) return null;
  const left = x + 250 <= width ? x + 14 : Math.max(0, x - 244);
  return <div className="stat-tooltip" style={{ left }} role="presentation"><strong>{row.title || row.label}</strong>{children}</div>;
}

export function StackedColumns({ title, subtitle, rows, series, format = compact, tooltip, describe }) {
  const [ref, width] = useWidth();
  const [hover, setHover] = useState(null);
  const band = (width - LEFT - 12) / Math.max(1, rows.length);
  const x = index => LEFT + (index + 0.5) * band;
  const max = niceMax(Math.max(0, ...rows.map(row => series.reduce((sum, item) => sum + (row.values[item.key] || 0), 0))));
  const scale = value => value / max * (HEIGHT - TOP - BOTTOM);
  const barWidth = Math.max(4, Math.min(30, band * 0.62));
  const hovered = hover === null ? null : rows[hover];
  return <Frame title={title} subtitle={subtitle} plotRef={ref}
    tooltip={<Tooltip row={hovered} x={hovered ? x(hover) : 0} width={width}>{hovered && tooltip(hovered)}</Tooltip>}>
    <svg viewBox={`0 0 ${width} ${HEIGHT}`} aria-hidden="false">
      <Axis width={width} right={8} max={max} format={format} />
      {rows.map((row, index) => {
        let base = HEIGHT - BOTTOM;
        const drawn = series.filter(item => row.values[item.key] > 0);
        return <g key={row.key} className={row.muted ? 'is-muted' : undefined}>{drawn.map((item, position) => {
          const height = scale(row.values[item.key]);
          const gap = position > 0 ? 2 : 0;
          base -= height + gap;
          return <path key={item.key} className={`stat-fill tone-${item.tone}${row.incomplete ? ' is-incomplete' : ''}`} d={columnPath(x(index) - barWidth / 2, base, barWidth, height, position === drawn.length - 1)} />;
        })}</g>;
      })}
      <line className="stat-baseline" x1={LEFT} x2={width - 8} y1={HEIGHT - BOTTOM} y2={HEIGHT - BOTTOM} />
      {hovered && <line className="stat-crosshair" x1={x(hover)} x2={x(hover)} y1={TOP} y2={HEIGHT - BOTTOM} />}
      <Labels rows={rows} x={x} band={band} />
      <Targets rows={rows} x={x} band={band} setHover={setHover} describe={describe} />
    </svg>
  </Frame>;
}

// Direct labels at each line's last point, nudged apart so close lines stay readable.
const LABEL_GAP = 14;
function endLabels(series, rows, y) {
  const labels = series.map(item => {
    const last = rows.map(row => row.values[item.key]).filter(Number.isFinite).at(-1);
    return last === undefined ? null : { key: item.key, text: item.label, y: y(last) };
  }).filter(Boolean).sort((a, b) => a.y - b.y);
  labels.forEach((label, index) => { if (index) label.y = Math.max(label.y, labels[index - 1].y + LABEL_GAP); });
  const overflow = (labels.at(-1)?.y ?? 0) - (HEIGHT - BOTTOM);
  if (overflow > 0) labels.forEach(label => { label.y -= overflow; });
  return labels;
}

// Lines on one zero-based scale; incomplete rows are hollow points on a dashed segment.
export function Lines({ title, subtitle, rows, series, format = compact, tooltip, describe }) {
  const [ref, width] = useWidth();
  const [hover, setHover] = useState(null);
  const right = series.length > 1 ? 96 : 16;
  const band = (width - LEFT - right) / Math.max(1, rows.length);
  const x = index => LEFT + (index + 0.5) * band;
  const values = rows.flatMap(row => series.map(item => row.values[item.key])).filter(Number.isFinite);
  const max = niceMax(Math.max(0, ...values));
  const y = value => HEIGHT - BOTTOM - value / max * (HEIGHT - TOP - BOTTOM);
  const hovered = hover === null ? null : rows[hover];
  return <Frame title={title} subtitle={subtitle} plotRef={ref}
    tooltip={<Tooltip row={hovered} x={hovered ? x(hover) : 0} width={width}>{hovered && tooltip(hovered)}</Tooltip>}>
    <svg viewBox={`0 0 ${width} ${HEIGHT}`}>
      <Axis width={width} right={right - 8} max={max} format={format} />
      {series.map(item => {
        const points = rows.map((row, index) => ({ row, index, value: row.values[item.key] })).filter(point => Number.isFinite(point.value));
        // A segment touching an incomplete point is dashed; the rest are solid.
        const segments = points.slice(1).map((point, position) => ({ from: points[position], to: point, dashed: Boolean(points[position].row.incomplete || point.row.incomplete) }));
        const path = dashed => segments.filter(segment => segment.dashed === dashed)
          .map(({ from, to }) => `M${x(from.index)},${y(from.value)}L${x(to.index)},${y(to.value)}`).join('');
        return <g key={item.key}>
          <path className={`stat-line tone-${item.tone}`} d={path(false)} />
          {segments.some(segment => segment.dashed) && <path className={`stat-line tone-${item.tone} is-incomplete`} d={path(true)} />}
          {points.map(point => <circle key={point.row.key} className={`stat-point tone-${item.tone}${point.row.incomplete ? ' is-incomplete' : ''}`} cx={x(point.index)} cy={y(point.value)} r={hover === point.index ? 5 : 4} />)}
        </g>;
      })}
      {series.length > 1 && endLabels(series, rows, y).map(label => <text key={label.key} className="stat-end" x={width - right + 12} y={label.y + 4}>{label.text}</text>)}
      <line className="stat-baseline" x1={LEFT} x2={width - right + 8} y1={HEIGHT - BOTTOM} y2={HEIGHT - BOTTOM} />
      {hovered && <line className="stat-crosshair" x1={x(hover)} x2={x(hover)} y1={TOP} y2={HEIGHT - BOTTOM} />}
      <Labels rows={rows} x={x} band={band} />
      <Targets rows={rows} x={x} band={band} setHover={setHover} describe={describe} />
    </svg>
  </Frame>;
}

export function Legend({ series, extra }) {
  return <ul className="stat-legend">{series.map(item => <li key={item.key}><i className={`stat-swatch tone-${item.tone}`} aria-hidden="true" /><span>{item.label}</span></li>)}{extra}</ul>;
}
