export const PAGE_SIZES = [12, 24, 48, 96];
export const DEFAULT_LIMIT = 24;
export const filterKeys = (program) => [
  "company",
  "location",
  "caseNumber",
  "jobTitle",
  program === "perm" ? "decisionYear" : "determinationYear",
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

export function writeSearchState(filters, page, limit, view) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(filters))
    if (String(value).trim()) params.set(key, String(value).trim());
  if (page > 1) params.set("page", String(page));
  if (limit !== DEFAULT_LIMIT) params.set("limit", String(limit));
  if (["table", "cards"].includes(view)) params.set("view", view);
  return params;
}
