// The deployed commit, baked in at build time from APP_VERSION (see vite.config.js).
// Empty in local builds, where no version is shown.
const raw = (import.meta.env?.VITE_APP_VERSION || '').trim();

export const APP_VERSION = raw;
export const APP_VERSION_SHORT = /^[0-9a-f]{7,40}$/i.test(raw) ? raw.slice(0, 7) : raw;
export const APP_VERSION_URL = /^[0-9a-f]{7,40}$/i.test(raw)
  ? `https://github.com/blueandhack/LaborLens/commit/${raw}`
  : null;
