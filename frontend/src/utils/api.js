// Public API reads. Responses are kept briefly in memory so going back to a page,
// or opening one whose data was prefetched (on hovering its link), shows at once.
// Requests for the same URL share one network call. Data changes only when new
// disclosures are imported, so a few minutes is safe.
const FRESH_MS = 5 * 60 * 1000;
const MAX_ENTRIES = 60;
const responses = new Map(); // url → { at, data } or { promise }

// ── Loading state for the progress bar ──────────────────────────────────────
// Counts requests a page is waiting on (prefetches are not counted).
let waiting = 0;
const listeners = new Set();
const notify = () => listeners.forEach(listener => listener(waiting));
export function subscribeLoading(listener) { listeners.add(listener); listener(waiting); return () => listeners.delete(listener); }

// A server restarting for a deploy can briefly drop a connection or answer through the
// proxy with a non-JSON error page (502, 503, 504). Those are retried quietly; real
// answers, including the API's own JSON errors, are not.
export const RETRY_DELAYS_MS = [400, 1200];
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function request(url) {
  for (let attempt = 0; ; attempt++) {
    let response = null, data;
    try {
      response = await fetch(url, { headers: { Accept: "application/json" } });
      data = await response.json();
    } catch (error) {
      if (attempt < RETRY_DELAYS_MS.length) { await wait(RETRY_DELAYS_MS[attempt]); continue; }
      throw Object.assign(new Error("Unable to load this page"), { status: response?.status || 0, cause: error });
    }
    if (!response.ok && [502, 504].includes(response.status) && attempt < RETRY_DELAYS_MS.length) { await wait(RETRY_DELAYS_MS[attempt]); continue; }
    if (!response.ok) throw Object.assign(new Error(data.error || "Unable to load this page"), { status: response.status });
    return data;
  }
}

function load(url) {
  const entry = responses.get(url);
  if (entry?.promise) return entry.promise;
  if (entry && Date.now() - entry.at < FRESH_MS) return Promise.resolve(entry.data);
  const promise = request(url).then(data => {
    responses.delete(url);
    responses.set(url, { at: Date.now(), data });
    while (responses.size > MAX_ENTRIES) responses.delete(responses.keys().next().value);
    return data;
  }).catch(error => { responses.delete(url); throw error; });
  responses.set(url, { promise });
  return promise;
}

// The cached response if it is fresh, so a page can render it on its first paint.
export function cachedJSON(url) {
  const entry = responses.get(url);
  return entry && !entry.promise && Date.now() - entry.at < FRESH_MS ? entry.data : undefined;
}

// `fresh` skips a kept response (for polling something that is still being prepared).
export function getJSON(url, { signal, fresh = false } = {}) {
  if (fresh && !responses.get(url)?.promise) responses.delete(url);
  const cached = cachedJSON(url);
  if (cached !== undefined) return Promise.resolve(cached);
  waiting += 1; notify();
  const done = () => { waiting -= 1; notify(); };
  const request = load(url);
  // Aborting stops this caller waiting; the shared request carries on for others.
  const aborted = signal && new Promise((_, reject) => {
    if (signal.aborted) reject(new DOMException("Aborted", "AbortError"));
    signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
  });
  const result = aborted ? Promise.race([request, aborted]) : request;
  result.then(done, done);
  return result;
}

// Starts loading in the background; errors are left for the page to show.
export function prefetchJSON(urls) {
  for (const url of urls) load(url).catch(() => {});
}
