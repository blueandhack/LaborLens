// Map outlines load on demand, outside the main bundle: the states once, and
// one county file per state when the map zooms into it.
let stateShapes = null, stateLoading = null;
export const loadedStates = () => stateShapes;
export const loadStates = () => (stateLoading ||= import('../data/usStates.json').then(module => (stateShapes = module.default.states)));

const countyModules = import.meta.glob('../data/counties/*.json', { import: 'default' });
const countyCache = new Map();
export function loadCounties(state) {
  const load = countyModules[`../data/counties/${state}.json`];
  if (!load) return Promise.resolve(null);
  if (!countyCache.has(state)) countyCache.set(state, load().catch(error => { countyCache.delete(state); throw error; }));
  return countyCache.get(state);
}
