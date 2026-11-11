import { programs } from "./programs.js";

export const PAGE_SIZES = [12, 24, 48, 96];
export const DEFAULT_LIMIT = 24;
export const filterKeys = (program) => [
  "company",
  "employer",
  "employerGroup",
  "location",
  "worksite",
  "worksiteState",
  "caseNumber",
  "jobTitle",
  programs[program].yearKey,
  "receivedYear",
];

export function readSearchState(params, program) {
  const filters = Object.fromEntries(
    filterKeys(program).map((key) => [key, params.get(key) || ""]),
  );
  for (const key of filterKeys(program).filter((key) => key.endsWith("Year")))
    if (!/^(?:19|20)\d{2}$/.test(filters[key])) filters[key] = "";
  const requestedPage = Number(params.get("page") || 1);
  const requestedLimit = Number(params.get("limit") || DEFAULT_LIMIT);
  return {
    filters,
    page:
      Number.isSafeInteger(requestedPage) && requestedPage > 0
        ? requestedPage
        : 1,
    limit: PAGE_SIZES.includes(requestedLimit) ? requestedLimit : DEFAULT_LIMIT,
  };
}

export function writeSearchState(filters, page, limit, view, sort) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(filters))
    if (String(value).trim()) params.set(key, key === 'employer' ? String(value) : String(value).trim());
  if (page > 1) params.set("page", String(page));
  if (limit !== DEFAULT_LIMIT) params.set("limit", String(limit));
  if (["table", "cards"].includes(view)) params.set("view", view);
  if (sort) params.set('sort', sort);
  return params;
}

// The API requests a case search makes, shared with link prefetching so both use
// the same URLs (a prefetched response is found by its exact URL).
export function searchRequests(program, { filters, page, limit, sort }) {
  const endpoint = programs[program].endpoint;
  const apiParams = writeSearchState(filters, page, limit, undefined, sort);
  apiParams.set("page", String(page));
  apiParams.set("limit", String(limit));
  const query = apiParams.toString();
  const countQuery = writeSearchState(filters, 1, DEFAULT_LIMIT).toString();
  return {
    query, countQuery,
    results: `${endpoint}?${query}&count=deferred`,
    count: `${endpoint}/count${countQuery ? `?${countQuery}` : ""}`,
    years: `${endpoint}/years`,
  };
}
