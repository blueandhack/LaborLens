import { useEffect, useRef, useState } from 'react';
import { subscribeLoading } from '../utils/api';
import './Loading.css';

// A slim progress bar across the top of the window while a page waits for data.
// It appears only after a short delay (quick loads do not flash), creeps toward
// the end while waiting, then completes and fades out.
const SHOW_AFTER_MS = 150;
export function LoadingBar() {
  const [bar, setBar] = useState({ visible: false, progress: 0, done: false });
  const timers = useRef({});
  useEffect(() => {
    const clear = () => { clearTimeout(timers.current.show); clearInterval(timers.current.creep); clearTimeout(timers.current.hide); };
    const unsubscribe = subscribeLoading(waiting => {
      if (waiting > 0) {
        if (timers.current.active) return;
        timers.current.active = true;
        clear();
        timers.current.show = setTimeout(() => {
          setBar({ visible: true, progress: 0.12, done: false });
          // Each step covers part of the remaining distance, so it slows but never finishes on its own.
          timers.current.creep = setInterval(() => setBar(current => ({ ...current, progress: current.progress + (0.92 - current.progress) * 0.12 })), 250);
        }, SHOW_AFTER_MS);
      } else if (timers.current.active) {
        timers.current.active = false;
        clear();
        setBar(current => current.visible ? { visible: true, progress: 1, done: true } : current);
        timers.current.hide = setTimeout(() => setBar({ visible: false, progress: 0, done: false }), 450);
      }
    });
    return () => { unsubscribe(); clear(); };
  }, []);
  return (
    <div className={`loading-bar${bar.visible ? ' is-visible' : ''}${bar.done ? ' is-done' : ''}`} aria-hidden="true">
      <span style={{ transform: `scaleX(${bar.progress})` }} />
    </div>
  );
}

// Placeholder shapes in the page's layout while its first data loads: filters,
// summary figures, a chart and table rows, with a soft moving sheen.
const BAR_HEIGHTS = [38, 52, 46, 61, 57, 70, 64, 78, 72, 86, 81, 93];
export function PageSkeleton({ label, controls = 3, stats = 4, chart = true, rows = 6 }) {
  return (
    <div className="page-skeleton" role="status" aria-live="polite">
      <span className="sr-only">{label}</span>
      <div aria-hidden="true" className="page-skeleton-body">
        {controls > 0 && <div className="sk-controls">{Array.from({ length: controls }, (_, i) => <span key={i} className="sk sk-field" />)}</div>}
        {stats > 0 && <div className="sk-stats">{Array.from({ length: stats }, (_, i) => (
          <div key={i} className="sk-card"><span className="sk sk-line is-short" /><span className="sk sk-figure" /><span className="sk sk-line" /></div>
        ))}</div>}
        {chart && <div className="sk-chart">
          {BAR_HEIGHTS.map((height, i) => <span key={i} className="sk sk-bar" style={{ height: `${height}%`, animationDelay: `${i * 70}ms` }} />)}
        </div>}
        {rows > 0 && <div className="sk-rows">{Array.from({ length: rows }, (_, i) => (
          <div key={i} className="sk-table-row"><span className="sk sk-line is-wide" /><span className="sk sk-line" /><span className="sk sk-line" /><span className="sk sk-line is-short" /></div>
        ))}</div>}
        <p className="sk-caption"><span className="sk-dot" /><span className="sk-dot" /><span className="sk-dot" />{label}</p>
      </div>
    </div>
  );
}
