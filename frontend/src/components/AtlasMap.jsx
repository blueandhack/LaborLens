import { memo, useEffect, useMemo, useRef, useState } from 'react';
import { FULL_VIEW, MAP_WIDTH, placeLabels, zoomPath } from '../utils/mapPresentation';
import { loadStates, loadedStates } from '../utils/mapShapes';
import './USMap.css';

const reducedMotion = () => typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

// Animates the viewBox toward target along a smooth zoom path.
function useZoom(target) {
  const [box, setBox] = useState(target);
  const current = useRef(target);
  const key = target.map(value => value.toFixed(3)).join(' ');
  useEffect(() => {
    const from = current.current;
    if (from.every((value, index) => Math.abs(value - target[index]) < 1e-3)) return undefined;
    if (reducedMotion()) { current.current = target; setBox(target); return undefined; }
    const path = zoomPath(from, target);
    let frame, start = null;
    const step = now => {
      start ??= now;
      const t = Math.min(1, (now - start) / path.duration);
      const eased = t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2;
      current.current = path.at(eased);
      setBox(current.current);
      if (t < 1) frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the key covers the target's values
  }, [key]);
  return box;
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
  const [shapes, setShapes] = useState(loadedStates);
  useEffect(() => { if (!shapes) loadStates().then(setShapes).catch(() => {}); }, [shapes]);
  const box = useZoom(view);
  const k = MAP_WIDTH / box[2];
  // Bubbles keep their on-screen size while zooming; small ones stay visible.
  const sized = useMemo(() => bubbles.map(bubble => ({ ...bubble, rr: Math.max(bubble.r, 1.6) / k })), [bubbles, k]);
  const labels = useMemo(() => labelLimit ? placeLabels(sized.filter(bubble => bubble.label).map(bubble => ({ ...bubble, r: bubble.rr })),
    { font: 11.5 / k, limit: labelLimit }) : [], [sized, labelLimit, k]);
  const handlers = useRef({ onHover, onSelect });
  useEffect(() => { handlers.current = { onHover, onSelect }; });
  const enter = useMemo(() => place => event => handlers.current.onHover?.(place, event), []);
  const select = useMemo(() => place => handlers.current.onSelect?.(place), []);
  const showCounties = countyFile && focusState && countyFile.code === focusState;
  return (
    <svg className={`us-map atlas-map${focusState ? ' is-zoomed' : ''}`} viewBox={box.join(' ')} role="img" aria-label={label}
      onPointerLeave={() => onHover?.(null)} style={{ '--k': k }}>
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
  );
}

export default memo(AtlasMap);
