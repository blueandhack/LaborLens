// A choice kept in this browser, read with useSyncExternalStore (the prerendered page has none).
export function browserStore(key) {
  const listeners = new Set();
  return {
    read() { try { return localStorage.getItem(key) || ''; } catch { return ''; } },
    subscribe(listener) {
      listeners.add(listener);
      window.addEventListener('storage', listener);
      return () => { listeners.delete(listener); window.removeEventListener('storage', listener); };
    },
    write(value) {
      try { if (value) localStorage.setItem(key, value); else localStorage.removeItem(key); } catch { /* The page works without browser storage. */ }
      listeners.forEach(listener => listener());
    },
  };
}
