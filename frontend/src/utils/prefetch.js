// Starts loading a page's data when a reader points at, focuses, or touches its link,
// so it is often ready by the time the click lands. Only each page's default view.
import { prefetchJSON } from './api.js';
import { readUscisState, uscisBreakdownURL, uscisEmployersURL, uscisOverviewURL } from './uscisPresentation.js';
import { readSearchState, searchRequests } from './searchState.js';
import { readCaseSort } from './sorting.js';

const empty = () => new URLSearchParams();
function caseSearch(program) {
  const { filters, page, limit } = readSearchState(empty(), program);
  const requests = searchRequests(program, { filters, page, limit, sort: readCaseSort(empty(), program) });
  return [requests.results, requests.count, requests.years];
}
const ROUTES = {
  '/': () => caseSearch('pwd'),
  '/perm': () => caseSearch('perm'),
  '/h1b': () => caseSearch('h1b'),
  '/h1b-approvals': () => { const state = readUscisState(empty()); return [uscisOverviewURL(state), uscisEmployersURL(state), uscisBreakdownURL(state)]; },
  '/i140': () => ['/api/i140'],
};

const started = new Map(); // path → time, so repeated hovers do not refetch
export function prefetchRoute(path) {
  if (!ROUTES[path] || Date.now() - (started.get(path) || 0) < 60000) return;
  started.set(path, Date.now());
  prefetchJSON(ROUTES[path]());
}
