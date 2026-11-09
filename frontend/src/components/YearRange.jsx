import { useId } from 'react';
import { normalizeRange, rangeParams } from '../utils/yearRange';

// "From" and "To" fiscal-year selects, with quick ranges.
export default function YearRange({ years, from, to, onChange, label = 'Fiscal years', format = year => `FY${year}` }) {
  const id = useId();
  const range = normalizeRange(years, from, to);
  const set = (start, end) => onChange(rangeParams(years, start, end));
  const last = years.at(-1);
  const presets = [['All', years[0]], ['Last 10', last - 9], ['Last 5', last - 4]].filter(([, start], index) => index === 0 || start > years[0]);
  return <fieldset className="year-range">
    <legend>{label}</legend>
    <div className="year-range-fields">
      <label htmlFor={`${id}-from`}><span>From</span><select id={`${id}-from`} className="search-input" value={range.from ?? ''} onChange={event => set(Number(event.target.value), Math.max(Number(event.target.value), range.to))}>
        {years.map(year => <option key={year} value={year}>{format(year)}</option>)}</select></label>
      <label htmlFor={`${id}-to`}><span>To</span><select id={`${id}-to`} className="search-input" value={range.to ?? ''} onChange={event => set(Math.min(range.from, Number(event.target.value)), Number(event.target.value))}>
        {years.map(year => <option key={year} value={year}>{format(year)}</option>)}</select></label>
      <div className="year-range-presets" role="group" aria-label="Quick ranges">
        {presets.map(([text, start]) => <button key={text} type="button" aria-pressed={range.from === start && range.to === last} onClick={() => set(start, last)}>{text}</button>)}
      </div>
    </div>
  </fieldset>;
}
