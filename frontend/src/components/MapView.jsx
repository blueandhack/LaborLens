import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { FiChevronRight, FiMapPin, FiMaximize2, FiRefreshCw, FiX, FiZoomIn, FiZoomOut } from 'react-icons/fi';
import AtlasMap from './AtlasMap';
import { loadCounties } from '../utils/mapShapes';
import { getJSON } from '../utils/api';
import { programs } from '../utils/programs';
import {
  MAP_PROGRAMS, RANK_MINIMUM, FULL_VIEW, mapMetrics, formatMetric, classBreaks, classOf, rampStep, legendEntries,
  bubbleRadius, placeSearchURL, readMapState, writeMapState, rankPlaces, fitBox, boundsOf,
} from '../utils/mapPresentation';
import './MapView.css';

// The Albers USA map draws the 50 states and DC; territories are listed below it.
const unmapped = new Set(['PR', 'GU', 'VI', 'AS', 'MP']);
const mapped = { has: code => !unmapped.has(code) };
const number = value => Number(value || 0).toLocaleString('en-US');
const percent = (part, whole) => whole ? Math.round(part / whole * 1000) / 10 + '%' : '0%';
// Cities drawn at state level, and how far (map units) a city's ZIP codes may lie from it.
const STATE_CITY_LIMIT = 400, ZIP_REACH = 6;
const KIND_LABEL = { state: 'State', county: 'County', city: 'City', zip: 'ZIP code' };
// Per-resident rates exist for states and counties; cities and ZIP codes rank by filings instead.
const rankMetric = (metric, kind) => metric === 'perCapita' && (kind === 'cities' || kind === 'zips') ? 'count' : metric;

function PlaceDetails({ place, program, year, occupation, occupationTitle, metric, onClose, onZoom, zoomLabel, stateName }) {
  const metrics = mapMetrics(program);
  const config = programs[program];
  const kicker = place.kind === 'metro' ? (place.type === 'micro' ? 'Micropolitan area' : 'Metropolitan area')
    : place.kind === 'county' ? `County · ${stateName}` : place.kind === 'city' ? `City · ${stateName}` : 'State';
  const shown = Object.entries(metrics).filter(([key]) => !(key === 'perCapita' && place.kind === 'city'));
  return (
    <section className="map-place" aria-labelledby="map-place-title" aria-live="polite">
      <header>
        <div><p className="section-kicker">{kicker}</p>
          <h2 id="map-place-title">{place.name}</h2></div>
        {onClose && <button type="button" className="map-icon-button" onClick={onClose} aria-label={place.kind === 'metro' ? 'Close place details' : 'Zoom out'}>
          {place.kind === 'metro' ? <FiX aria-hidden="true" /> : <FiZoomOut aria-hidden="true" />}</button>}
      </header>
      <dl>
        {shown.map(([key, info]) => (
          <div key={key} className={key === metric ? 'is-current' : undefined}><dt>{info.short}</dt><dd>{formatMetric(key, place[key])}</dd></div>
        ))}
      </dl>
      <p>{config.label} filings{year !== 'all' ? ` in ${year}` : ''}{occupation !== 'all' ? ` for ${occupationTitle || occupation}` : ''}.</p>
      <div className="map-place-actions">
        {onZoom && <button type="button" className="btn btn-secondary" onClick={onZoom}><FiZoomIn aria-hidden="true" /> {zoomLabel}</button>}
        <Link className="btn" to={placeSearchURL(program, place, { year })}><FiMapPin aria-hidden="true" />
          {place.kind === 'metro' ? `Search ${config.label} cases in ${place.name.split(',')[0].split('-')[0]}, ${place.state}`
            : place.kind === 'city' ? `Search ${config.label} cases in ${place.name}, ${place.state}`
              : `Search ${config.label} cases in ${place.kind === 'county' ? stateName : place.name}`}</Link>
      </div>
      <small>{place.kind === 'metro' ? 'Search matches the area’s principal city by its reported worksite; suburbs in the same metro area are not included. ' : ''}
        {place.kind === 'county' ? 'Case search filters by state and city, not county. Choose a city below to search it. ' : ''}
        {place.kind === 'city' ? 'Search matches the reported worksite city, so other spellings may be missed. ' : ''}
        {occupation !== 'all' ? 'Case search does not filter by occupation, so it lists every occupation.' : ''}</small>
    </section>
  );
}

function Ranking({ title, rows, metric, kind, nameHeader, selected, onSelect, program, note }) {
  const metrics = mapMetrics(program);
  const measure = rankMetric(metric, kind);
  const ranked = rankPlaces(rows, measure, kind);
  const keyOf = row => row.kind + ':' + row.code;
  return (
    <section className="map-ranking" aria-label={title}>
      {title && <h2>{title} · {metrics[measure].short}</h2>}
      {measure !== metric && <p>{metrics[metric].short} is not available here; ranked by filings.</p>}
      {measure !== 'count' && RANK_MINIMUM[kind] && <p>Places with at least {RANK_MINIMUM[kind]} filings.</p>}
      {note && <p>{note}</p>}
      {ranked.length ? <table>
        <thead><tr><th scope="col">{nameHeader}</th><th scope="col">{metrics[measure].short}</th>{measure !== 'count' && <th scope="col">Filings</th>}</tr></thead>
        <tbody>{ranked.map(row => (
          <tr key={keyOf(row)} className={selected === keyOf(row) ? 'is-selected' : undefined}>
            <th scope="row">{onSelect ? <button type="button" onClick={() => onSelect(row)} aria-pressed={selected === keyOf(row)}>{row.name}</button> : <span>{row.name}</span>}</th>
            <td>{formatMetric(measure, row[measure])}</td>{measure !== 'count' && <td>{number(row.count)}</td>}
          </tr>
        ))}</tbody>
      </table> : <p>No place has enough filings for this measure.</p>}
    </section>
  );
}

function Breadcrumbs({ trail, onZoomOut }) {
  return (
    <nav className="map-crumbs" aria-label="Map zoom">
      <ol>{trail.map((crumb, index) => (
        <li key={crumb.label}>
          {index > 0 && <FiChevronRight aria-hidden="true" />}
          {index < trail.length - 1 ? <button type="button" onClick={crumb.go}>{crumb.label}</button> : <span aria-current="location">{crumb.label}</span>}
        </li>
      ))}</ol>
      {trail.length > 1 && <div className="map-zoom-buttons">
        <button type="button" className="map-icon-button" onClick={onZoomOut} aria-label="Zoom out one level" title="Zoom out (Esc)"><FiZoomOut aria-hidden="true" /></button>
        <button type="button" className="map-icon-button" onClick={trail[0].go} aria-label="Show the whole country" title="Whole country"><FiMaximize2 aria-hidden="true" /></button>
      </div>}
    </nav>
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
  const [local, setLocal] = useState({ key: null, data: null, error: null });
  const [countyFile, setCountyFile] = useState(null);
  const [hover, setHover] = useState(null);
  const [selection, setSelection] = useState(null);
  const [rankKind, setRankKind] = useState('counties');
  const [retry, setRetry] = useState(0);
  const figure = useRef(null);
  const config = programs[program];
  const metrics = mapMetrics(program);
  const key = `${program}|${year}|${occupation}|${retry}`;
  const focusState = mapped.has(state.state) ? state.state : '';
  const localKey = focusState ? `${key}|${focusState}` : null;

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

  useEffect(() => {
    if (!localKey) return undefined;
    const controller = new AbortController();
    const query = new URLSearchParams({ program, year, occupation, state: focusState });
    getJSON('/api/map/local?' + query, { signal: controller.signal })
      .then(data => setLocal({ key: localKey, data, error: null }))
      .catch(() => { if (!controller.signal.aborted) setLocal({ key: localKey, data: null, error: 'County and city detail could not load.' }); });
    return () => controller.abort();
  }, [localKey, program, year, occupation, focusState]);

  useEffect(() => {
    if (!focusState) return undefined;
    let live = true;
    loadCounties(focusState).then(file => { if (live) setCountyFile(file); }).catch(() => {});
    return () => { live = false; };
  }, [focusState]);

  const loading = result.key !== key;
  const data = loading ? last : result.data;
  const error = !loading && result.error;
  const programOptions = options.program === program ? options.data : null;

  const places = useMemo(() => ({
    states: (data?.states || []).map(row => ({ ...row, kind: 'state' })),
    metros: (data?.metros || []).map(row => ({ ...row, kind: 'metro' })),
  }), [data]);

  // --- Zoomed place ---
  const file = focusState && countyFile?.code === focusState ? countyFile : null;
  const localLoading = Boolean(localKey) && local.key !== localKey;
  const localData = local.key === localKey ? local.data : local.data?.state === focusState ? local.data : null;
  const counties = (localData?.counties || []).map(row => ({ ...row, kind: 'county', code: row.fips, state: focusState }));
  const cities = (localData?.cities || []).map(row => ({ ...row, kind: 'city', code: row.key, state: focusState }));
  const countyShape = file?.counties.find(county => county.fips === state.county) || null;
  const focusCounty = countyShape ? countyShape.fips : '';
  const cityRow = state.city ? cities.find(row => row.key === state.city) || null : null;
  const level = !focusState ? 'nation' : state.city && (cityRow || localLoading) ? 'city' : focusCounty ? 'county' : 'state';
  const stateRow = places.states.find(row => row.code === focusState) || (focusState ? { kind: 'state', code: focusState, name: focusState, count: 0 } : null);
  const stateName = stateRow?.name || focusState;
  const countyRow = focusCounty ? counties.find(row => row.code === focusCounty) || { kind: 'county', code: focusCounty, name: countyShape.name, state: focusState, count: 0 } : null;
  const zoomTo = changes => { setSelection(null); setHover(null); update({ state: '', county: '', city: '', ...changes }); };
  const zoomOut = () => level === 'city' ? zoomTo({ state: focusState, county: focusCounty }) : level === 'county' ? zoomTo({ state: focusState }) : zoomTo({});

  useEffect(() => {
    if (!focusState) return undefined;
    const onKey = event => {
      if (event.key !== 'Escape' || event.defaultPrevented || /^(INPUT|SELECT|TEXTAREA)$/.test(event.target?.tagName)) return;
      zoomOut();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  // --- Shading and marks for the current level ---
  let stateSteps = {}, countySteps = {}, bubbles = [], breaks = [], labelLimit = 0, legendSize = null;
  const stepper = values => { breaks = classBreaks(values); return value => { const index = classOf(value, breaks); return index ? rampStep(index, breaks) : 0; }; };
  const inCounty = row => row.county === focusCounty;
  if (level === 'nation') {
    const shown = view === 'metros' ? places.metros.filter(row => row.x !== null) : places.states.filter(row => mapped.has(row.code));
    const stepOf = stepper(shown.map(row => row[metric]));
    if (view === 'states') stateSteps = Object.fromEntries(shown.map(row => [row.code, stepOf(row[metric])]));
    const maxCount = Math.max(0, ...shown.map(row => row.count));
    if (view === 'metros') {
      bubbles = shown.map(row => ({ id: 'metro:' + row.code, x: row.x, y: row.y, r: bubbleRadius(row.count, maxCount), step: stepOf(row[metric]), place: row }));
      legendSize = 'Circle area shows the number of filings.';
    }
  } else {
    const stepOf = stepper(counties.map(row => row[metric]));
    countySteps = Object.fromEntries(counties.map(row => [row.code, stepOf(row[metric])]));
    const drawn = cities.filter(row => row.x !== null);
    if (level === 'state') {
      const top = drawn.slice(0, STATE_CITY_LIMIT), max = Math.max(0, ...top.map(row => row.count));
      bubbles = top.map(row => ({ id: 'city:' + row.code, x: row.x, y: row.y, r: bubbleRadius(row.count, max, 14), neutral: true, place: row, label: row.name }));
      labelLimit = 10; legendSize = 'Circle area shows filings in each city.';
    } else if (level === 'county') {
      const here = drawn.filter(inCounty), max = Math.max(0, ...here.map(row => row.count));
      bubbles = here.map(row => ({ id: 'city:' + row.code, x: row.x, y: row.y, r: bubbleRadius(row.count, max, 18), neutral: true, place: row, label: row.name }));
      labelLimit = 16; legendSize = 'Circle area shows filings in each city.';
    } else if (cityRow) {
      const zips = cityRow.x === null ? [] : cityRow.zips.filter(row => row.x !== null && Math.hypot(row.x - cityRow.x, row.y - cityRow.y) <= ZIP_REACH);
      const max = Math.max(0, ...zips.map(row => row.count));
      const neighbors = drawn.filter(row => row.code !== cityRow.code && (focusCounty ? inCounty(row) : true)).slice(0, 60);
      bubbles = [
        ...neighbors.map(row => ({ id: 'city:' + row.code, x: row.x, y: row.y, r: 3, neutral: true, dim: true, place: row, label: row.name })),
        ...(zips.length ? zips.map(row => ({ id: 'zip:' + row.zip, x: row.x, y: row.y, r: bubbleRadius(row.count, max, 18), neutral: true,
          place: { kind: 'zip', code: row.zip, name: 'ZIP ' + row.zip, count: row.count }, label: row.zip }))
          : cityRow.x !== null ? [{ id: 'city:' + cityRow.code, x: cityRow.x, y: cityRow.y, r: 8, neutral: true, place: cityRow, label: cityRow.name }] : []),
      ];
      labelLimit = 14; legendSize = zips.length ? 'Circle area shows filings in each ZIP code.' : null;
    }
  }

  let target = FULL_VIEW;
  if (file) {
    target = fitBox(file.box, { padding: 0.04 });
    if (countyShape) target = fitBox(countyShape.box, { padding: 0.06 });
    if (level === 'city' && cityRow?.x != null) {
      const zips = cityRow.zips.filter(row => row.x !== null && Math.hypot(row.x - cityRow.x, row.y - cityRow.y) <= ZIP_REACH);
      target = fitBox(boundsOf([[cityRow.x, cityRow.y], ...zips.map(row => [row.x, row.y])]), { padding: 0.25, minimum: 5 });
    }
  }

  const selectedKey = level === 'city' ? 'city:' + state.city : level === 'county' ? 'county:' + focusCounty
    : selection && selection.program === program ? selection.kind + ':' + selection.code : null;
  const selectedPlace = selection && selection.program === program && level === 'nation'
    ? (selection.kind === 'metro' ? places.metros : places.states).find(row => row.code === selection.code) : null;
  const selectMetro = place => setSelection(current => current?.kind === place.kind && current.code === place.code && current.program === program ? null : { kind: place.kind, code: place.code, program });
  const openCity = row => zoomTo({ state: focusState, county: row.county || focusCounty, city: row.code });
  const onSelect = place => {
    if (place.kind === 'state') { if (mapped.has(place.code)) zoomTo({ state: place.code }); }
    else if (place.kind === 'county') zoomTo({ state: focusState, county: place.code });
    else if (place.kind === 'city') openCity(cities.find(row => row.code === place.code) || place);
    else if (place.kind === 'metro') selectMetro(place);
  };

  const onHover = (place, event) => {
    if (!place || !figure.current || event?.pointerType === 'touch') { setHover(null); return; }
    const box = figure.current.getBoundingClientRect();
    const source = { state: places.states, metro: places.metros, county: counties, city: cities }[place.kind];
    const row = source ? source.find(item => item.code === place.code) : place;
    setHover({ name: place.kind === 'city' && row ? row.name : place.name, kind: place.kind, row, x: event.clientX - box.left, y: event.clientY - box.top, width: box.width });
  };

  const occupationTitle = data?.occupationTitle || programOptions?.occupations.find(row => row.code === occupation)?.title;
  const heading = level === 'nation' ? `${config.label} filings by ${view === 'metros' ? 'metro area' : 'state'}`
    : level === 'state' ? `${config.label} filings in ${stateName} by county and city`
      : level === 'county' ? `${config.label} filings in ${countyRow.name}, ${focusState}, by city`
        : `${config.label} filings in ${cityRow?.name || state.city}, ${focusState}`;
  const trail = [{ label: 'United States', go: () => zoomTo({}) }];
  if (focusState) trail.push({ label: stateName, go: () => zoomTo({ state: focusState }) });
  if (countyRow) trail.push({ label: countyRow.name, go: () => zoomTo({ state: focusState, county: focusCounty }) });
  if (level === 'city') trail.push({ label: cityRow?.name || state.city, go: () => {} });
  const outside = level === 'nation' ? [...places.states.filter(row => !mapped.has(row.code)), ...(view === 'metros' ? places.metros.filter(row => row.x === null) : [])] : [];
  const countyLocated = counties.reduce((sum, row) => sum + row.count, 0);
  const metroTotal = places.metros.reduce((sum, row) => sum + row.count, 0);
  const filterText = `${year !== 'all' ? ` in ${year}` : ''}${occupation !== 'all' ? ` for ${occupationTitle || occupation}` : ''}`;
  const zoomedTotal = level === 'county' ? countyRow?.count : level === 'city' ? cityRow?.count : localData?.total;
  const zoomedName = level === 'county' ? countyRow?.name : level === 'city' ? `${cityRow?.name || state.city}, ${focusState}` : stateName;
  const countyCities = level === 'state' ? cities : cities.filter(inCounty);

  return (
    <article className="map-page">
      <header className="map-intro">
        <p className="section-kicker">Worksite map · DOL disclosure records</p>
        <h1>Where sponsored jobs are located</h1>
        <p>Explore H-1B labor condition applications, PERM labor certifications, and prevailing wage determinations by the worksite reported in each case. Zoom from the whole country into a state, a county and a city, and compare filing volume, filings per resident, typical wages, and the share of experienced-level positions.</p>
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
        {level === 'nation' && <fieldset className="map-segmented">
          <legend>Show</legend>
          <div>{[['states', 'States'], ['metros', 'Metro areas']].map(([value, label]) => <button key={value} type="button" aria-pressed={view === value} onClick={() => update({ view: value })}>{label}</button>)}</div>
        </fieldset>}
      </form>

      {data && level === 'nation' && <p className="map-coverage" aria-live="polite">
        <strong>{number(data.total)}</strong> {config.label} filings{filterText}.
        {' '}{data.total > 0 && `${percent(data.located, data.total)} report a usable worksite state; ${percent(metroTotal, data.total)} are placed in a metro or micro area.`}
      </p>}
      {level !== 'nation' && <p className="map-coverage" aria-live="polite">
        {localData ? <><strong>{number(zoomedTotal)}</strong> {config.label} filings in {zoomedName}{filterText}.
          {level === 'state' && localData.total > 0 && ` ${percent(countyLocated, localData.total)} are placed in a county by their worksite ZIP code or city.`}</>
          : local.error ? local.error : 'Loading county and city detail…'}
      </p>}

      {error ? <div className="search-state" role="alert"><h2>Map unavailable</h2><p>{error}</p><button className="btn" type="button" onClick={() => setRetry(value => value + 1)}><FiRefreshCw aria-hidden="true" /> Try again</button></div>
        : data && !data.ready ? <div className="search-state" role="status"><h2>The map is being prepared</h2><p>Worksite summaries are built in the background after data imports. Please check back shortly; case search is available now.</p></div>
          : <div className="map-layout">
            <figure className={`map-figure${loading || localLoading ? ' is-loading' : ''}`} ref={figure} aria-busy={loading || localLoading}>
              <figcaption><h2>{heading}</h2><p>{level === 'nation' ? metrics[metric].description : `Counties are shaded by ${metrics[metric].label.toLowerCase()}${metric === 'perCapita' ? ' (cities have no population estimate here)' : ''}. ${level === 'city' ? 'Circles show the ZIP codes this city’s filings report.' : 'Select a county or city to zoom in.'}`} Drag to move the map; scroll or pinch to zoom.</p></figcaption>
              <Breadcrumbs trail={trail} onZoomOut={zoomOut} />
              <div className="map-canvas">
                <AtlasMap view={target} stateSteps={stateSteps} focusState={focusState} countyFile={file} countySteps={countySteps} focusCounty={focusCounty}
                  bubbles={bubbles} labelLimit={labelLimit} selected={selectedKey} onHover={onHover} onSelect={onSelect}
                  label={`${heading}, shaded by ${metrics[metric].label.toLowerCase()}. The ranked table lists the same values.`} />
                {hover && <div className="map-tooltip" role="presentation" style={{ left: Math.max(0, Math.min(hover.x + 14, hover.width - 230)), top: hover.y + 14 }}>
                  <span className="map-tooltip-kind">{hover.kind === 'metro' ? 'Metro area' : KIND_LABEL[hover.kind]}</span>
                  <strong>{hover.name}</strong>
                  {hover.row ? <dl>
                    <div><dt>Filings</dt><dd>{number(hover.row.count)}</dd></div>
                    {metric !== 'count' && hover.kind !== 'zip' && !(metric === 'perCapita' && hover.kind === 'city') && <div><dt>{metrics[metric].short}</dt><dd>{formatMetric(metric, hover.row[metric])}</dd></div>}
                  </dl> : <span>No filings</span>}
                  {((hover.kind === 'state' && level === 'nation') || (hover.kind === 'county' && hover.row?.code !== focusCounty) || (hover.kind === 'city' && level !== 'city')) &&
                    <em>Click to zoom in</em>}
                </div>}
                {(loading || localLoading) && <div className="map-loading" role="status">Loading…</div>}
                {localData && !localData.ready && <div className="map-notice" role="status">County and city detail is being prepared and will appear after the next map refresh.</div>}
              </div>
              <div className="map-legend" aria-label="Legend">
                <span className="map-legend-title">{metrics[metric].short}{level !== 'nation' ? ' by county' : ''}</span>
                <ul>{legendEntries(metric, breaks).map(entry => <li key={entry.step + entry.label}><i data-step={entry.step} aria-hidden="true" />{entry.label}</li>)}
                  <li><i data-step="0" aria-hidden="true" />{view === 'metros' && level === 'nation' ? 'Too few to measure' : 'No filings or too few'}</li></ul>
                {legendSize && <span className="map-legend-size"><b className={level === 'nation' ? undefined : 'is-neutral'} aria-hidden="true" />{legendSize}</span>}
              </div>
              {outside.length > 0 && <p className="map-outside">Not drawn on this map: {outside.slice(0, 8).map(row => `${row.name} (${number(row.count)})`).join(' · ')}{outside.length > 8 ? ` and ${outside.length - 8} more` : ''}.</p>}
            </figure>
            <aside className="map-side">
              {level === 'nation' && (selectedPlace
                ? <PlaceDetails place={selectedPlace} program={program} year={year} occupation={occupation} occupationTitle={occupationTitle} metric={metric}
                  onClose={() => setSelection(null)} onZoom={() => zoomTo({ state: selectedPlace.state })} zoomLabel={`Zoom into ${selectedPlace.state}`} />
                : <p className="map-hint">Select a state to zoom into its counties and cities{view === 'metros' ? ', or a circle for metro-area details' : ''}.</p>)}
              {level === 'state' && stateRow && <PlaceDetails place={stateRow} program={program} year={year} occupation={occupation} occupationTitle={occupationTitle} metric={metric} onClose={zoomOut} stateName={stateName} />}
              {level === 'county' && countyRow && <PlaceDetails place={countyRow} program={program} year={year} occupation={occupation} occupationTitle={occupationTitle} metric={metric} onClose={zoomOut} stateName={stateName} />}
              {level === 'city' && (cityRow ? <PlaceDetails place={cityRow} program={program} year={year} occupation={occupation} occupationTitle={occupationTitle} metric={metric} onClose={zoomOut} stateName={stateName} />
                : !localLoading && <div className="map-empty"><p>No {config.label} filings{filterText} report this city.</p></div>)}

              {level === 'nation' && (data && data.total === 0 && !loading ? <div className="map-empty"><p>No {config.label} filings match this year and occupation.</p>
                {(occupation !== 'all' || year !== 'all') && <button type="button" className="btn btn-secondary" onClick={() => update({ occupation: 'all', year: 'all' })}>Show all years and occupations</button>}</div>
                : <Ranking title={view === 'metros' ? 'Top metro areas' : 'Top states'} nameHeader={view === 'metros' ? 'Area' : 'State'} rows={view === 'metros' ? places.metros : places.states}
                  metric={metric} kind={view} selected={selectedKey} onSelect={onSelect} program={program} />)}
              {level === 'state' && localData && <>
                <fieldset className="map-segmented map-rank-kind">
                  <legend className="sr-only">Rank</legend>
                  <div>{[['counties', 'Counties'], ['cities', 'Cities']].map(([value, label]) => <button key={value} type="button" aria-pressed={rankKind === value} onClick={() => setRankKind(value)}>{label}</button>)}</div>
                </fieldset>
                <Ranking title={rankKind === 'cities' ? `Top cities in ${stateName}` : `Top counties in ${stateName}`} nameHeader={rankKind === 'cities' ? 'City' : 'County'}
                  rows={rankKind === 'cities' ? cities : counties} metric={metric} kind={rankKind} selected={selectedKey} onSelect={onSelect} program={program}
                  note={rankKind === 'cities' && localData.otherCities > 0 ? `${number(localData.otherCities)} smaller city names (${number(localData.otherCityFilings)} filings) are not listed.` : null} />
              </>}
              {level === 'county' && localData && <Ranking title={`Cities in ${countyRow.name}`} nameHeader="City" rows={countyCities} metric={metric} kind="cities"
                selected={selectedKey} onSelect={onSelect} program={program} note={countyCities.length ? null : 'No reported city in this county could be placed.'} />}
              {level === 'city' && cityRow && cityRow.zips.length > 0 && <Ranking title={`ZIP codes in ${cityRow.name}`} nameHeader="ZIP code"
                rows={cityRow.zips.map(row => ({ ...row, kind: 'zip', code: row.zip, name: row.zip }))} metric="count" kind="zips" program={program}
                note="The ZIP codes most often reported with this city." />}
            </aside>
          </div>}

      <details className="map-method">
        <summary>How this map is made</summary>
        <ul>
          <li>Each filing is placed by its reported primary worksite: the ZIP code’s county and metro or micropolitan area (2023 Census delineations), and the reported state. Filings without a ZIP code are placed by worksite city only when other filings consistently put that city in one area. Additional H-1B worksites are not counted.</li>
          <li>Counties are 2023 Census counties (Connecticut uses its planning regions). Cities are the worksite city names reported in filings, combined across capitalization, punctuation and abbreviations such as “St.”; each city is drawn at the middle of the ZIP codes its filings report, in the county where most of them are. Cities never reported with a ZIP code are listed but not drawn.</li>
          <li>Years are calendar years of the {config.dateLabel.toLowerCase()}, matching case search. Older occupation codes (SOC 2000 and 2010) are combined with their SOC 2018 successor using the O*NET crosswalks; where a code was split, it goes to the closest-titled successor.</li>
          <li>Counts are applications, not workers, visa approvals or hires, and include withdrawn and denied applications. Wages are reported offers or determinations, not payroll.</li>
          <li>Sources: U.S. Department of Labor disclosure files; U.S. Census Bureau ZIP code relationship files, Gazetteer, cartographic boundaries, metro delineations and population estimates; O*NET crosswalks (USDOL/ETA, CC BY 4.0). <Link to="/data">Data sources and methodology.</Link></li>
        </ul>
        {programOptions?.updatedAt && <p>Map updated {new Date(programOptions.updatedAt).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' })}.</p>}
      </details>
    </article>
  );
}
