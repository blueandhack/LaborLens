import { memo, useEffect, useState } from 'react';
import { loadStates, loadedStates } from '../utils/mapShapes';
import './USMap.css';

// State outlines (~35 kB gzipped) load on demand, outside the main bundle.
const WIDTH = 975, HEIGHT = 610;

// Albers USA SVG of the states (Alaska and Hawaii inset) with optional metro
// bubbles. Fill steps 1–5 use the sequential ramp in USMap.css; 0 is no data.
// Pointer handlers receive the hovered place (or null) for a tooltip.
function USMap({ stateSteps = {}, bubbles = [], selected = null, onHover, onSelect, label, compact = false }) {
  const [states, setStates] = useState(loadedStates);
  useEffect(() => { if (!states) loadStates().then(setStates).catch(() => {}); }, [states]);
  const enter = place => event => onHover?.(place, event);
  const leave = () => onHover?.(null);
  return (
    <svg className={`us-map${compact ? ' us-map-compact' : ''}`} viewBox={`0 0 ${WIDTH} ${HEIGHT}`} role="img" aria-label={label}
      onPointerLeave={leave}>
      <g className="us-map-states">
        {(states || []).map(state => {
          const place = { kind: 'state', code: state.code, name: state.name };
          return <path key={state.code} d={state.d} data-step={stateSteps[state.code] || 0}
            className={selected === 'state:' + state.code ? 'is-selected' : undefined}
            onPointerEnter={enter(place)} onPointerMove={enter(place)} onClick={onSelect ? () => onSelect(place) : undefined} />;
        })}
      </g>
      {bubbles.length > 0 && <g className="us-map-bubbles">
        {[...bubbles].sort((a, b) => b.r - a.r).map(bubble => (
          <circle key={bubble.code} cx={bubble.x} cy={bubble.y} r={bubble.r} data-step={bubble.step}
            className={selected === 'metro:' + bubble.code ? 'is-selected' : undefined}
            onPointerEnter={enter(bubble.place)} onPointerMove={enter(bubble.place)} onClick={onSelect ? () => onSelect(bubble.place) : undefined} />
        ))}
      </g>}
    </svg>
  );
}

export default memo(USMap);
