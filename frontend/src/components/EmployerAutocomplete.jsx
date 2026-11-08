import { useEffect, useId, useState } from 'react';
import { getJSON } from '../utils/api';
import './Employers.css';

export default function EmployerAutocomplete({ id, value, onChange, onSelect, label = 'Employer name', placeholder = 'e.g. Amazon' }) {
  const listId = useId();
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const [response, setResponse] = useState({ key: null, employers: [], error: false });
  const query = value.trim();
  const items = response.key === query ? response.employers : [];
  const visible = open && query.length >= 2;
  useEffect(() => {
    if (!open || query.length < 2) return;
    const controller = new AbortController();
    const timer = setTimeout(() => getJSON('/api/employers?q=' + encodeURIComponent(query), { signal: controller.signal })
      .then(data => { if (!controller.signal.aborted) { setResponse({ key: query, employers: data.employers, error: false }); setActive(-1); } })
      .catch(() => { if (!controller.signal.aborted) setResponse({ key: query, employers: [], error: true }); }), 200);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [query, open]);
  const choose = item => { onSelect(item); setOpen(false); setActive(-1); };
  return <div className="employer-autocomplete field-employer">
    <label htmlFor={id}>{label}</label>
    <input id={id} name="company" className="search-input" value={value} placeholder={placeholder} autoComplete="off" maxLength={160}
      role="combobox" aria-autocomplete="list" aria-expanded={visible} aria-controls={listId}
      aria-activedescendant={visible && active >= 0 && items[active] ? `${listId}-${active}` : undefined}
      onFocus={() => setOpen(true)} onBlur={() => setOpen(false)}
      onChange={event => { onChange(event.target.value); setActive(-1); setOpen(true); }}
      onKeyDown={event => {
        if (event.key === 'Escape') { setOpen(false); return; }
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
          event.preventDefault(); setOpen(true);
          setActive(index => items.length ? (index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length : -1);
        } else if (event.key === 'Enter' && visible && active >= 0 && items[active]) { event.preventDefault(); choose(items[active]); }
      }} />
    {visible && <div className="employer-suggestions">
      <ul id={listId} role="listbox" aria-label="Reported employer names">
        {items.map((item, index) => <li role="presentation" key={item.id}><button type="button" role="option" id={`${listId}-${index}`} tabIndex={-1}
          aria-selected={index === active} onMouseDown={event => event.preventDefault()} onClick={() => choose(item)}>
          <strong>{item.name}</strong><span>{Object.entries(item.programs).map(([program, info]) => `${program === 'h1b' ? 'H-1B' : program.toUpperCase()} ${info.count.toLocaleString()}`).join(' · ')}</span>
          {item.location && <small>{item.location}</small>}
        </button></li>)}
      </ul>
      {!items.length && <p role="status">{response.key !== query ? 'Finding employer names…' : response.error ? 'Suggestions unavailable. You can still search by name.' : 'No suggestions. You can still search this name.'}</p>}
      {items.length > 0 && <p>Choose a reported name for an exact match. Similar names stay separate.</p>}
    </div>}
  </div>;
}
