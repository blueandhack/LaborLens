import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { FiMapPin, FiRefreshCw, FiX } from 'react-icons/fi';
import USMap from './USMap';
import { getJSON } from '../utils/api';
import { programs } from '../utils/programs';
import {
  MAP_PROGRAMS, RANK_MINIMUM, mapMetrics, formatMetric, classBreaks, classOf, rampStep, legendEntries,
  bubbleRadius, placeSearchURL, readMapState, writeMapState, rankPlaces,
} from '../utils/mapPresentation';
import './MapView.css';

// The Albers USA map draws the 50 states and DC; territories are listed below it.
const unmapped = new Set(['PR', 'GU', 'VI', 'AS', 'MP']);
const mapped = { has: code => !unmapped.has(code) };
const number = value => Number(value || 0).toLocaleString('en-US');
const percent = (part, whole) => whole ? Math.round(part / whole * 1000) / 10 + '%' : '0%';

function PlaceDetails({ place, program, year, occupation, occupationTitle, metric, onClose }) {
  const metrics = mapMetrics(program);
  const config = programs[program];
  return (
    <section className="map-place" aria-labelledby="map-place-title" aria-live="polite">
      <header>
        <div><p className="section-kicker">{place.kind === 'metro' ? (place.type === 'micro' ? 'Micropolitan area' : 'Metropolitan area') : 'State'}</p>
          <h2 id="map-place-title">{place.name}</h2></div>
        <button type="button" className="map-icon-button" onClick={onClose} aria-label="Close place details"><FiX aria-hidden="true" /></button>
      </header>
      <dl>
        {Object.entries(metrics).map(([key, info]) => (
          <div key={key} className={key === metric ? 'is-current' : undefined}><dt>{info.short}</dt><dd>{formatMetric(key, place[key])}</dd></div>
        ))}
      </dl>
      <p>{config.label} filings{year !== 'all' ? ` in ${year}` : ''}{occupation !== 'all' ? ` for ${occupationTitle || occupation}` : ''}.</p>
      <Link className="btn" to={placeSearchURL(program, place, { year })}><FiMapPin aria-hidden="true" />
        {place.kind === 'metro' ? `Search ${config.label} cases in ${place.name.split(',')[0].split('-')[0]}, ${place.state}` : `Search ${config.label} cases in ${place.name}`}</Link>
      <small>{place.kind === 'metro' ? 'Search matches the area’s principal city by its reported worksite; suburbs in the same metro area are not included. ' : ''}
        {occupation !== 'all' ? 'Case search does not filter by occupation, so it lists every occupation.' : ''}</small>
    </section>
  );
}

function Ranking({ rows, metric, view, selected, onSelect, program }) {
  const metrics = mapMetrics(program);
  const ranked = rankPlaces(rows, metric, view);
  return (
    <section className="map-ranking" aria-labelledby="map-ranking-title">
      <h2 id="map-ranking-title">{view === 'metros' ? 'Top metro areas' : 'Top states'} · {metrics[metric].short}</h2>
      {metric !== 'count' && <p>Places with at least {RANK_MINIMUM[view]} filings.</p>}
      {ranked.length ? <table>
        <thead><tr><th scope="col">{view === 'metros' ? 'Area' : 'State'}</th><th scope="col">{metrics[metric].short}</th>{metric !== 'count' && <th scope="col">Filings</th>}</tr></thead>
        <tbody>{ranked.map(row => {
          const key = row.kind + ':' + row.code;
          return <tr key={key} className={selected === key ? 'is-selected' : undefined}>
            <th scope="row"><button type="button" onClick={() => onSelect(row)} aria-pressed={selected === key}>{row.name}</button></th>
            <td>{formatMetric(metric, row[metric])}</td>{metric !== 'count' && <td>{number(row.count)}</td>}
          </tr>;
        })}</tbody>
      </table> : <p>No place has enough filings for this measure.</p>}
    </section>
  );
}

export default function MapView() {
  const [params, setParams] = useSearchParams();
  const state = readMapState(params);
  const { program, year, occupation, metric, view } = state;
  const update = changes => setParams(writeMapState({ ...state, ...changes }));
  const [options, setOptions] = useState({ program: null, data: null, error: null });
  const [result, setResult] = useState({ key: null, data: null, error: null });
  const [last, setLast] = useState(null);
  const [hover, setHover] = useState(null);
  const [selection, setSelection] = useState(null);
  const [retry, setRetry] = useState(0);
  const figure = useRef(null);
  const config = programs[program];
  const metrics = mapMetrics(program);
  const key = `${program}|${year}|${occupation}|${retry}`;

  useEffect(() => {
    const controller = new AbortController();
    getJSON('/api/map/options?program=' + program, { signal: controller.signal })
      .then(data => setOptions({ program, data, error: null }))
      .catch(error => { if (!controller.signal.aborted) setOptions({ program, data: null, error: error.message }); });
    return () => controller.abort();
  }, [program, retry]);

  useEffect(() => {
    const controller = new AbortController();
    const query = new URLSearchParams({ program, year, occupation });
    getJSON('/api/map?' + query, { signal: controller.signal })
      .then(data => { setResult({ key, data, error: null }); setLast(data); })
      .catch(error => { if (!controller.signal.aborted) setResult({ key, data: null, error: error.status === 400 ? error.message : 'The map could not load. Please try again.' }); });
    return () => controller.abort();
  }, [key, program, year, occupation]);

  const loading = result.key !== key;
  const data = loading ? last : result.data;
  const error = !loading && result.error;
  const programOptions = options.program === program ? options.data : null;

  const places = useMemo(() => ({
    states: (data?.states || []).map(row => ({ ...row, kind: 'state' })),
    metros: (data?.metros || []).map(row => ({ ...row, kind: 'metro' })),
  }), [data]);
  const shown = view === 'metros' ? places.metros.filter(row => row.x !== null) : places.states.filter(row => mapped.has(row.code));
  const breaks = classBreaks(shown.map(row => row[metric]));
  const stepOf = value => { const index = classOf(value, breaks); return index ? rampStep(index, breaks) : 0; };
  const stateSteps = view === 'states' ? Object.fromEntries(shown.map(row => [row.code, stepOf(row[metric])])) : {};
  const maxCount = Math.max(0, ...shown.map(row => row.count));
  const bubbles = view === 'metros' ? shown.map(row => ({ code: row.code, x: row.x, y: row.y, r: bubbleRadius(row.count, maxCount), step: stepOf(row[metric]), place: row })) : [];
  const outside = [...places.states.filter(row => !mapped.has(row.code)), ...(view === 'metros' ? places.metros.filter(row => row.x === null) : [])];
  const selectedKey = selection && selection.program === program ? selection.kind + ':' + selection.code : null;
  const selectedPlace = selectedKey ? (selection.kind === 'metro' ? places.metros : places.states).find(row => row.code === selection.code) : null;
  const select = place => setSelection(current => current?.kind === place.kind && current.code === place.code && current.program === program ? null : { kind: place.kind, code: place.code, program });
  const metroTotal = places.metros.reduce((sum, row) => sum + row.count, 0);

  const onHover = (place, event) => {
    if (!place || !figure.current || event?.pointerType === 'touch') { setHover(null); return; }
    const box = figure.current.getBoundingClientRect();
    const row = (place.kind === 'metro' ? places.metros : places.states).find(item => item.code === place.code);
    setHover({ name: place.name, row, x: event.clientX - box.left, y: event.clientY - box.top, width: box.width });
  };

  const occupationTitle = data?.occupationTitle || programOptions?.occupations.find(row => row.code === occupation)?.title;
  const heading = `${config.label} filings by ${view === 'metros' ? 'metro area' : 'state'}`;

  return (
    <article className="map-page">
      <header className="map-intro">
        <p className="section-kicker">Worksite map · DOL disclosure records</p>
        <h1>Where sponsored jobs are located</h1>
        <p>Explore H-1B labor condition applications, PERM labor certifications, and prevailing wage determinations by the worksite state and metro area reported in each case. Compare filing volume, filings per resident, typical wages, and the share of experienced-level positions.</p>
      </header>

      <form className="map-controls" aria-label="Map options" onSubmit={event => event.preventDefault()}>
        <fieldset className="map-segmented">
          <legend>Program</legend>
          <div>{MAP_PROGRAMS.map(item => <button key={item} type="button" aria-pressed={item === program} onClick={() => update({ program: item })}>{programs[item].label}</button>)}</div>
        </fieldset>
        <label htmlFor="map-year">{config.yearLabel}
          <select id="map-year" className="search-input" value={year} onChange={event => update({ year: event.target.value })}>
            <option value="all">All years</option>
            {[...new Set([...(year !== 'all' ? [Number(year)] : []), ...(programOptions?.years || []).map(row => row.year)])].sort((a, b) => b - a)
              .map(value => <option key={value} value={value}>{value}</option>)}
          </select>
        </label>
        <label htmlFor="map-occupation" className="map-occupation">Occupation (SOC)
          <select id="map-occupation" className="search-input" value={occupation} onChange={event => update({ occupation: event.target.value })}>
            <option value="all">All occupations</option>
            {occupation !== 'all' && !programOptions?.occupations.some(row => row.code === occupation) && <option value={occupation}>{occupationTitle || occupation}</option>}
            {(programOptions?.occupations || []).map(row => <option key={row.code} value={row.code}>{row.title} · {row.code}</option>)}
          </select>
        </label>
        <label htmlFor="map-metric">Measure
          <select id="map-metric" className="search-input" value={metric} onChange={event => update({ metric: event.target.value })}>
            {Object.entries(metrics).map(([value, info]) => <option key={value} value={value}>{info.label}</option>)}
          </select>
        </label>
        <fieldset className="map-segmented">
          <legend>Show</legend>
          <div>{[['states', 'States'], ['metros', 'Metro areas']].map(([value, label]) => <button key={value} type="button" aria-pressed={view === value} onClick={() => update({ view: value })}>{label}</button>)}</div>
        </fieldset>
      </form>

      {data && <p className="map-coverage" aria-live="polite">
        <strong>{number(data.total)}</strong> {config.label} filings{year !== 'all' ? ` in ${year}` : ''}{occupation !== 'all' ? ` for ${occupationTitle || occupation}` : ''}.
        {' '}{data.total > 0 && `${percent(data.located, data.total)} report a usable worksite state; ${percent(metroTotal, data.total)} are placed in a metro or micro area.`}
      </p>}

      {error ? <div className="search-state" role="alert"><h2>Map unavailable</h2><p>{error}</p><button className="btn" type="button" onClick={() => setRetry(value => value + 1)}><FiRefreshCw aria-hidden="true" /> Try again</button></div>
        : data && !data.ready ? <div className="search-state" role="status"><h2>The map is being prepared</h2><p>Worksite summaries are built in the background after data imports. Please check back shortly; case search is available now.</p></div>
          : <div className="map-layout">
            <figure className={`map-figure${loading ? ' is-loading' : ''}`} ref={figure} aria-busy={loading}>
              <figcaption><h2>{heading}</h2><p>{metrics[metric].description}</p></figcaption>
              <div className="map-canvas">
                <USMap stateSteps={stateSteps} bubbles={bubbles} selected={selectedKey} onHover={onHover} onSelect={select}
                  label={`${heading}, shaded by ${metrics[metric].label.toLowerCase()}. The ranked table lists the same values.`} />
                {hover && <div className="map-tooltip" role="presentation" style={{ left: Math.min(hover.x + 14, hover.width - 230), top: hover.y + 14 }}>
                  <strong>{hover.name}</strong>
                  {hover.row ? <dl>
                    <div><dt>Filings</dt><dd>{number(hover.row.count)}</dd></div>
                    {metric !== 'count' && <div><dt>{metrics[metric].short}</dt><dd>{formatMetric(metric, hover.row[metric])}</dd></div>}
                  </dl> : <span>No filings</span>}
                </div>}
                {loading && <div className="map-loading" role="status">Loading…</div>}
              </div>
              <div className="map-legend" aria-label="Legend">
                <span className="map-legend-title">{metrics[metric].short}</span>
                <ul>{legendEntries(metric, breaks).map(entry => <li key={entry.step + entry.label}><i data-step={entry.step} aria-hidden="true" />{entry.label}</li>)}
                  <li><i data-step="0" aria-hidden="true" />{view === 'metros' ? 'Too few to measure' : 'No filings or too few'}</li></ul>
                {view === 'metros' && <span className="map-legend-size">Circle area shows the number of filings.</span>}
              </div>
              {outside.length > 0 && <p className="map-outside">Not drawn on this map: {outside.slice(0, 8).map(row => `${row.name} (${number(row.count)})`).join(' · ')}{outside.length > 8 ? ` and ${outside.length - 8} more` : ''}.</p>}
            </figure>
            <aside className="map-side">
              {selectedPlace ? <PlaceDetails place={selectedPlace} program={program} year={year} occupation={occupation} occupationTitle={occupationTitle} metric={metric} onClose={() => setSelection(null)} />
                : <p className="map-hint">Select a {view === 'metros' ? 'circle' : 'state'} or a row below for details and matching cases.</p>}
              {data && data.total === 0 && !loading ? <div className="map-empty"><p>No {config.label} filings match this year and occupation.</p>
                {(occupation !== 'all' || year !== 'all') && <button type="button" className="btn btn-secondary" onClick={() => update({ occupation: 'all', year: 'all' })}>Show all years and occupations</button>}</div>
                : <Ranking rows={view === 'metros' ? places.metros : places.states} metric={metric} view={view} selected={selectedKey} onSelect={select} program={program} />}
            </aside>
          </div>}

      <details className="map-method">
        <summary>How this map is made</summary>
        <ul>
          <li>Each filing is placed by its reported primary worksite: the ZIP code’s metro or micropolitan area (2023 Census delineations), and the reported state. Filings without a ZIP code are placed by worksite city only when other filings consistently put that city in one area. Additional H-1B worksites are not counted.</li>
          <li>Years are calendar years of the {config.dateLabel.toLowerCase()}, matching case search. Older occupation codes (SOC 2000 and 2010) are combined with their SOC 2018 successor using the O*NET crosswalks; where a code was split, it goes to the closest-titled successor.</li>
          <li>Counts are applications, not workers, visa approvals or hires, and include withdrawn and denied applications. Wages are reported offers or determinations, not payroll.</li>
          <li>Sources: U.S. Department of Labor disclosure files; U.S. Census Bureau ZIP code relationship files, metro delineations and population estimates; O*NET crosswalks (USDOL/ETA, CC BY 4.0). <Link to="/data">Data sources and methodology.</Link></li>
        </ul>
        {programOptions?.updatedAt && <p>Map updated {new Date(programOptions.updatedAt).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' })}.</p>}
      </details>
    </article>
  );
}
