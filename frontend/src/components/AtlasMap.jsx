import { memo, useEffect, useMemo, useRef, useState } from 'react';
import { FiMinus, FiPlus, FiRotateCcw } from 'react-icons/fi';
import { FULL_VIEW, MAP_WIDTH, MAX_VIEW_WIDTH, MIN_VIEW_WIDTH, placeLabels, zoomPath, zoomBoxAt, panBox } from '../utils/mapPresentation';
import { loadStates, loadedStates } from '../utils/mapShapes';
import './USMap.css';

const reducedMotion = () => typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

const same = (a, b) => a.every((value, index) => Math.abs(value - b[index]) < 1e-3);

// The viewBox: animates toward target along a smooth zoom path whenever the
// target changes (or on reset), and follows the reader's own panning and zooming.
function useZoom(target) {
  const [box, setBox] = useState(target);
  const current = useRef(target), frame = useRef(0);
  const [reset, setReset] = useState(0);
  // Whether the reader has moved away from the target view.
  const [free, setFree] = useState(false);
  const key = target.map(value => value.toFixed(3)).join(' ');
  useEffect(() => {
    const from = current.current;
    cancelAnimationFrame(frame.current);
    setFree(false);
    if (same(from, target)) return undefined;
    if (reducedMotion()) { current.current = target; setBox(target); return undefined; }
    const path = zoomPath(from, target);
    let start = null;
    const step = now => {
      start ??= now;
      const t = Math.min(1, (now - start) / path.duration);
      const eased = t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2;
      current.current = path.at(eased);
      setBox(current.current);
      if (t < 1) frame.current = requestAnimationFrame(step);
    };
    frame.current = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the key covers the target's values
  }, [key, reset]);
  const controls = useMemo(() => ({
    get: () => current.current,
    // Immediate change from the reader's gestures; stops any running animation.
    set: next => { cancelAnimationFrame(frame.current); current.current = next; setBox(next); setFree(true); },
    reset: () => setReset(value => value + 1),
  }), []);
  return [box, controls, free];
}

// Drag to pan, wheel or trackpad to zoom at the pointer, and two-finger pinch.
// A drag never counts as a click on the place under it.
function useGestures(svg, view, onStart) {
  const state = useRef({ pointers: new Map(), moved: false, suppress: false });
  useEffect(() => {
    const element = svg.current;
    if (!element) return undefined;
    const toMap = (clientX, clientY) => {
      const rect = element.getBoundingClientRect(), box = view.current.get();
      return [box[0] + (clientX - rect.left) / rect.width * box[2], box[1] + (clientY - rect.top) / rect.height * box[3]];
    };
    const unitsPerPixel = () => view.current.get()[2] / element.getBoundingClientRect().width;
    const onWheel = event => {
      const box = view.current.get();
      const factor = Math.exp(-event.deltaY * (event.deltaMode === 1 ? 16 : 1) * (event.ctrlKey ? 0.01 : 0.002));
      // At the widest view, scrolling out scrolls the page instead.
      if (factor < 1 && box[2] >= MAX_VIEW_WIDTH - 1e-6) return;
      event.preventDefault();
      onStart();
      view.current.set(zoomBoxAt(box, toMap(event.clientX, event.clientY), factor));
    };
    const s = state.current;
    const onDown = event => {
      if (event.pointerType === 'mouse' && event.button !== 0) return;
      s.pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
      if (s.pointers.size === 1) { s.moved = false; s.start = { x: event.clientX, y: event.clientY }; }
    };
    const onMove = event => {
      const previous = s.pointers.get(event.pointerId);
      if (!previous) return;
      const points = [...s.pointers.values()];
      if (points.length === 1) {
        if (!s.moved && Math.hypot(event.clientX - s.start.x, event.clientY - s.start.y) < 4) return;
        if (!s.moved) { s.moved = true; element.setPointerCapture?.(event.pointerId); element.classList.add('is-dragging'); onStart(); }
        const scale = unitsPerPixel();
        view.current.set(panBox(view.current.get(), (event.clientX - previous.x) * scale, (event.clientY - previous.y) * scale));
      } else if (points.length === 2) {
        const other = points.find(point => point !== previous);
        const before = Math.hypot(previous.x - other.x, previous.y - other.y);
        const after = Math.hypot(event.clientX - other.x, event.clientY - other.y);
        const scale = unitsPerPixel();
        const panned = panBox(view.current.get(), (event.clientX - previous.x) / 2 * scale, (event.clientY - previous.y) / 2 * scale);
        view.current.set(before > 0 ? zoomBoxAt(panned, toMap((event.clientX + other.x) / 2, (event.clientY + other.y) / 2), after / before) : panned);
        if (!s.moved) { s.moved = true; onStart(); }
      }
      s.pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    };
    const onUp = event => {
      if (!s.pointers.delete(event.pointerId)) return;
      if (s.pointers.size === 0) {
        element.classList.remove('is-dragging');
        if (s.moved) { s.suppress = true; setTimeout(() => { s.suppress = false; }, 0); }
      }
    };
    const onClick = event => { if (s.suppress) { event.stopPropagation(); event.preventDefault(); s.suppress = false; } };
    element.addEventListener('wheel', onWheel, { passive: false });
    element.addEventListener('pointerdown', onDown);
    element.addEventListener('pointermove', onMove);
    element.addEventListener('pointerup', onUp);
    element.addEventListener('pointercancel', onUp);
    element.addEventListener('click', onClick, true);
    return () => {
      element.removeEventListener('wheel', onWheel);
      element.removeEventListener('pointerdown', onDown);
      element.removeEventListener('pointermove', onMove);
      element.removeEventListener('pointerup', onUp);
      element.removeEventListener('pointercancel', onUp);
      element.removeEventListener('click', onClick, true);
    };
  }, [svg, view, onStart]);
}

// Shape layers do not depend on the zoom, so they render once per data change.
const States = memo(function States({ shapes, steps, focus, selected, enter, onSelect }) {
  return (
    <g className="us-map-states">
      {shapes.map(state => {
        const place = { kind: 'state', code: state.code, name: state.name };
        const context = focus && focus !== state.code;
        // Alaska and Hawaii are insets, not neighbors: hide them when zoomed elsewhere.
        if (focus === state.code || (context && (state.code === 'AK' || state.code === 'HI'))) return null;
        return <path key={state.code} d={state.d} data-step={context ? undefined : steps[state.code] || 0}
          className={context ? 'is-context' : selected === 'state:' + state.code ? 'is-selected' : undefined}
          onPointerEnter={enter(place)} onPointerMove={enter(place)} onClick={() => onSelect(place)} />;
      })}
    </g>
  );
});

const Counties = memo(function Counties({ file, steps, focus, selected, enter, onSelect }) {
  return (
    <g className="us-map-counties">
      {file.counties.map(county => {
        const place = { kind: 'county', code: county.fips, name: county.name, state: file.code };
        const classes = [focus && focus !== county.fips ? 'is-dim' : '', focus === county.fips || selected === 'county:' + county.fips ? 'is-selected' : ''].filter(Boolean).join(' ');
        return <path key={county.fips} d={county.d} data-step={steps[county.fips] || 0} className={classes || undefined}
          onPointerEnter={enter(place)} onPointerMove={enter(place)} onClick={() => onSelect(place)} />;
      })}
      <path className="us-map-outline" d={file.outline} />
    </g>
  );
});

// Albers USA map that zooms from the nation to a state, county or city.
// bubbles: { id, x, y, r (radius at full view, in map units), step, neutral, place, label }.
function AtlasMap({ view = FULL_VIEW, stateSteps = {}, focusState = '', countyFile = null, countySteps = {}, focusCounty = '',
  bubbles = [], labelLimit = 0, selected = null, onHover, onSelect, label }) {
  const handlers = useRef({ onHover, onSelect });
  const [shapes, setShapes] = useState(loadedStates);
  useEffect(() => { if (!shapes) loadStates().then(setShapes).catch(() => {}); }, [shapes]);
  const [box, zoom, free] = useZoom(view);
  const svg = useRef(null);
  const zoomRef = useRef(zoom);
  const hideHover = useMemo(() => () => handlers.current.onHover?.(null), []);
  useGestures(svg, zoomRef, hideHover);
  const k = MAP_WIDTH / box[2];
  // Zooming in past the level's own view makes room for more labels.
  const labelRoom = Math.min(4, Math.max(1, view[2] / box[2]));
  // Bubbles keep their on-screen size while zooming; small ones stay visible.
  const sized = useMemo(() => bubbles.map(bubble => ({ ...bubble, rr: Math.max(bubble.r, 1.6) / k })), [bubbles, k]);
  const labels = useMemo(() => labelLimit ? placeLabels(sized.filter(bubble => bubble.label).map(bubble => ({ ...bubble, r: bubble.rr })),
    { font: 11.5 / k, limit: Math.round(labelLimit * labelRoom) }) : [], [sized, labelLimit, k, labelRoom]);
  useEffect(() => { handlers.current = { onHover, onSelect }; });
  const enter = useMemo(() => place => event => handlers.current.onHover?.(place, event), []);
  const select = useMemo(() => place => handlers.current.onSelect?.(place), []);
  const showCounties = countyFile && focusState && countyFile.code === focusState;
  const zoomBy = factor => zoom.set(zoomBoxAt(box, [box[0] + box[2] / 2, box[1] + box[3] / 2], factor));
  return (<>
    <svg ref={svg} className={`us-map atlas-map${focusState ? ' is-zoomed' : ''}`} viewBox={box.join(' ')} role="img" aria-label={label}
      onPointerLeave={() => onHover?.(null)}>
      {shapes && <States shapes={shapes} steps={stateSteps} focus={showCounties ? focusState : ''} selected={selected} enter={enter} onSelect={select} />}
      {showCounties && <Counties file={countyFile} steps={countySteps} focus={focusCounty} selected={selected} enter={enter} onSelect={select} />}
      {sized.length > 0 && <g className="us-map-bubbles">
        {[...sized].sort((a, b) => b.rr - a.rr).map(bubble => (
          <circle key={bubble.id} cx={bubble.x} cy={bubble.y} r={bubble.rr} data-step={bubble.neutral ? undefined : bubble.step}
            className={[bubble.neutral ? 'is-neutral' : '', selected === bubble.id ? 'is-selected' : '', bubble.dim ? 'is-dim' : ''].filter(Boolean).join(' ') || undefined}
            onPointerEnter={enter(bubble.place)} onPointerMove={enter(bubble.place)} onClick={() => select(bubble.place)} />
        ))}
      </g>}
      {labels.length > 0 && <g className="us-map-labels" aria-hidden="true" style={{ fontSize: 11.5 / k }}>
        {labels.map(item => <text key={item.id} x={item.lx} y={item.ly} strokeWidth={3 / k}>{item.label}</text>)}
      </g>}
    </svg>
    <div className="map-zoom-controls">
      <button type="button" onClick={() => zoomBy(1.6)} disabled={box[2] <= MIN_VIEW_WIDTH + 1e-6} aria-label="Zoom in" title="Zoom in (or scroll on the map)"><FiPlus aria-hidden="true" /></button>
      <button type="button" onClick={() => zoomBy(1 / 1.6)} disabled={box[2] >= MAX_VIEW_WIDTH - 1e-6} aria-label="Zoom out" title="Zoom out (or scroll on the map)"><FiMinus aria-hidden="true" /></button>
      {free && <button type="button" onClick={zoom.reset} aria-label="Reset the view" title="Reset the view"><FiRotateCcw aria-hidden="true" /></button>}
    </div>
  </>);
}

export default memo(AtlasMap);
