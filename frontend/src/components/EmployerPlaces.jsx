import { useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import AtlasMap from './AtlasMap';
import { programs } from '../utils/programs';
import { bubbleRadius, formatMetric, placeSearchURL, principalCity, wageNoun } from '../utils/mapPresentation';

const number = value => Number(value || 0).toLocaleString('en-US');

// Where one employer's filings for a program are located, by metro area.
export default function EmployerPlaces({ employer, program, places }) {
  const [hover, setHover] = useState(null);
  const figure = useRef(null);
  if (!places?.located) return null;
  const config = programs[program];
  const metros = places.metros.map(row => ({ ...row, kind: 'metro' }));
  const drawn = metros.filter(row => row.x !== null);
  const max = Math.max(0, ...drawn.map(row => row.count));
  const bubbles = drawn.map(row => ({ id: 'metro:' + row.code, x: row.x, y: row.y, r: bubbleRadius(row.count, max, 24), place: row, label: principalCity(row.name) }));
  const top = metros.slice(0, 8);
  const onHover = (place, event) => {
    if (!place || place.kind !== 'metro' || !figure.current || event?.pointerType === 'touch') { setHover(null); return; }
    const box = figure.current.getBoundingClientRect();
    setHover({ place, x: event.clientX - box.left, y: event.clientY - box.top, width: box.width });
  };
  const noun = wageNoun(program);
  return (
    <section className="employer-places" aria-labelledby={'employer-places-' + program}>
      <div className="employer-places-map" ref={figure}>
        <h3 id={'employer-places-' + program}>Where these filings are located</h3>
        <p>Reported primary worksites by metro area. Circle area shows the number of filings. Drag to move the map; scroll or pinch to zoom.</p>
        <div className="map-canvas">
          <AtlasMap compact bubbles={bubbles} labelLimit={5} onHover={onHover} label={`Map of ${config.label} filing worksites by metro area. The list beside it names the largest areas.`} />
          {hover && <div className="map-tooltip" role="presentation" style={{ left: Math.min(hover.x + 14, hover.width - 230), top: hover.y + 14 }}>
            <strong>{hover.place.name}</strong>
            <dl><div><dt>Filings</dt><dd>{number(hover.place.count)}</dd></div>
              {hover.place.median !== null && <div><dt>Median wage</dt><dd>{formatMetric('median', hover.place.median)}</dd></div>}</dl>
          </div>}
        </div>
        <p className="employer-chart-note">{number(places.metroLocated)} of {number(places.total)} filings are placed in a metro or micropolitan area; {number(places.located)} have a usable worksite location.</p>
      </div>
      <div className="employer-places-list">
        <h3>Largest worksite areas</h3>
        <ol>{top.map(row => <li key={row.code}>
          <Link to={placeSearchURL(program, row, { employer })} aria-label={`${row.name}: ${number(row.count)} ${config.label} filings. Search these cases.`}>
            <span>{row.name}</span><strong>{number(row.count)}</strong>
          </Link>
          <small>{row.median !== null ? `Median ${noun} ${formatMetric('median', row.median)} a year` : 'Too few wages for a median'}</small>
        </li>)}</ol>
        <p>Yearly amounts convert hourly wages at 2,080 hours. Links search the area’s principal city. <Link to={'/map?' + new URLSearchParams({ ...(program === 'h1b' ? {} : { program }), view: 'metros' })}>Compare all employers on the map.</Link></p>
      </div>
    </section>
  );
}
