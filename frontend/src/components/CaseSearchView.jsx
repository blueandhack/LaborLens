import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { getJSON } from "../utils/api";
import { useSearchParams, useLocation } from "react-router-dom";
import {
  FiArrowLeft,
  FiArrowRight,
  FiGrid,
  FiList,
  FiSearch,
  FiX,
  FiRefreshCw,
  FiSliders,
  FiBarChart2,
} from "react-icons/fi";
import CaseResults from "./CaseResults";
import { programs } from "../utils/programs";
import {
  PAGE_SIZES,
  readSearchState,
  writeSearchState,
} from "../utils/searchState";

const SearchInsights = lazy(() => import("./SearchInsights"));

const savedView = () => {
  try {
    return localStorage.getItem("laborlens-results-view");
  } catch {
    return null;
  }
};

function SearchFilters({
  initialValues,
  program,
  years,
  onSearch,
  onClear,
  loading,
}) {
  const [draft, setDraft] = useState(initialValues);
  const perm = program !== "pwd";
  const config = programs[program];
  const yearKey = config.yearKey;
  const edit = (key) => (event) =>
    setDraft((values) => ({ ...values, [key]: event.target.value }));
  return (
    <form
      className="case-search-form"
      role="search"
      aria-label={`Search ${config.label} cases`}
      onSubmit={(event) => {
        event.preventDefault();
        onSearch(draft);
      }}
    >
      <div className="primary-search-fields">
        <label className="field-employer" htmlFor="search-company">
          Employer name
          <input
            id="search-company"
            name="company"
            className="search-input"
            placeholder="e.g. Amazon"
            value={draft.company}
            onChange={edit("company")}
            autoComplete="off"
          />
        </label>
        <label htmlFor="search-job">
          Job title
          <input
            id="search-job"
            name="jobTitle"
            className="search-input"
            placeholder="e.g. Software"
            value={draft.jobTitle}
            onChange={edit("jobTitle")}
            autoComplete="off"
          />
        </label>
        <label htmlFor="search-location">
          Employer location
          <input
            id="search-location"
            name="location"
            className="search-input"
            placeholder="City or state"
            value={draft.location}
            onChange={edit("location")}
            autoComplete="off"
          />
        </label>
      </div>
      <div className="search-refinements">
        <details
          className="advanced-search"
          open={Boolean(
            initialValues.caseNumber ||
            initialValues[yearKey] ||
            initialValues.receivedYear,
          )}
        >
          <summary>
            <FiSliders aria-hidden="true" />
            Case number and dates
          </summary>
          <div className="advanced-search-fields">
            <label htmlFor="search-case">
              Case number
              <input
                id="search-case"
                name="caseNumber"
                className="search-input case-search-input"
                placeholder={program === "h1b" ? "e.g. I-200-26001" : perm ? "e.g. A-24123-45678" : "e.g. P-100-26092"}
                value={draft.caseNumber}
                onChange={edit("caseNumber")}
                autoComplete="off"
                spellCheck="false"
              />
            </label>
            <label htmlFor="search-event-year">
              {config.yearLabel}
              <select
                id="search-event-year"
                name={yearKey}
                className="search-input"
                value={draft[yearKey]}
                onChange={edit(yearKey)}
              >
                <option value="">Any year</option>
                {[
                  ...new Set([
                    ...(draft[yearKey] ? [Number(draft[yearKey])] : []),
                    ...years,
                  ]),
                ]
                  .sort((a, b) => b - a)
                  .map((year) => (
                    <option key={year} value={year}>
                      {year}
                    </option>
                  ))}
              </select>
            </label>
            <label htmlFor="search-received-year">
              {config.receivedLabel} year
              <select
                id="search-received-year"
                name="receivedYear"
                className="search-input"
                value={draft.receivedYear}
                onChange={edit("receivedYear")}
              >
                <option value="">Any year</option>
                {[
                  ...new Set([
                    ...(draft.receivedYear ? [Number(draft.receivedYear)] : []),
                    ...years,
                  ]),
                ]
                  .sort((a, b) => b - a)
                  .map((year) => (
                    <option key={year} value={year}>
                      {year}
                    </option>
                  ))}
              </select>
            </label>
          </div>
        </details>
        <div className="search-actions">
          <button
            className="btn btn-secondary"
            type="button"
            onClick={() => {
              setDraft(
                Object.fromEntries(Object.keys(draft).map((key) => [key, ""])),
              );
              onClear();
            }}
          >
            Reset
          </button>
          <button
            className="btn search-submit"
            type="submit"
            disabled={loading}
          >
            <FiSearch aria-hidden="true" />
            {loading ? "Searching…" : "Search cases"}
          </button>
        </div>
      </div>
      <p className="search-hint">
        Search by the beginning of a name, title, city, or case number. Combine
        fields to narrow your results.
      </p>
    </form>
  );
}

export default function CaseSearchView({ program }) {
  const [params, setParams] = useSearchParams();
  const location = useLocation();
  const { filters, page, limit } = readSearchState(params, program);
  const [years, setYears] = useState([]);
  const [yearsError, setYearsError] = useState(false);
  const [retry, setRetry] = useState(0);
  const [insightsOpen, setInsightsOpen] = useState(false);
  const [response, setResponse] = useState({
    key: null,
    data: null,
    error: null,
  });
  const [preference, setPreference] = useState(savedView);
  const [wide, setWide] = useState(
    () => window.matchMedia("(min-width: 960px)").matches,
  );
  const resultsHeading = useRef(null);
  const config = programs[program];
  const endpoint = config.endpoint;
  const apiParams = writeSearchState(filters, page, limit);
  apiParams.set("page", String(page));
  apiParams.set("limit", String(limit));
  const query = apiParams.toString();
  const requestKey = `${endpoint}?${query}&retry=${retry}`;
  const loading = response.key !== requestKey;
  const error = !loading && response.error;
  const data = !loading && !error ? response.data : null;
  const viewParam = params.get("view");
  const view = ["table", "cards"].includes(viewParam)
    ? viewParam
    : ["table", "cards"].includes(preference)
      ? preference
      : wide
        ? "table"
        : "cards";
  const filtersKey = JSON.stringify(filters);
  const activeFilters = Object.entries(filters).filter(([, value]) => value);
  const filterLabels = {
    company: "Employer",
    location: "Location",
    caseNumber: "Case",
    jobTitle: "Job",
    determinationYear: "Determined",
    decisionYear: program === "h1b" ? "Last action" : "Decided",
    receivedYear: config.receivedLabel,
  };

  useEffect(() => {
    document.title = `${config.title} | LaborLens`;
  }, [config.title]);

  useEffect(() => {
    const media = window.matchMedia("(min-width: 960px)");
    const listener = (event) => setWide(event.matches);
    media.addEventListener("change", listener);
    return () => media.removeEventListener("change", listener);
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    let current = true;
    getJSON(`${endpoint}?${query}`, {
        signal: controller.signal,
      })
      .then((result) => {
        if (current)
          setResponse({ key: requestKey, data: result, error: null });
      })
      .catch((failure) => {
        if (current && !controller.signal.aborted)
          setResponse({
            key: requestKey,
            data: null,
            error:
              failure.status === 503 || failure.status === 400
                ? failure.message
                : "We couldn’t load these cases. Your search has been kept. Please try again.",
          });
      });
    return () => {
      current = false;
      controller.abort();
    };
  }, [endpoint, query, requestKey]);

  useEffect(() => {
    const controller = new AbortController();
    getJSON(`${endpoint}/years`, { signal: controller.signal })
      .then((result) => {
        setYears(result);
        setYearsError(false);
      })
      .catch(() => {
        if (!controller.signal.aborted) setYearsError(true);
      });
    return () => controller.abort();
  }, [endpoint]);

  const update = (
    nextFilters = filters,
    nextPage = page,
    nextLimit = limit,
    nextView = viewParam,
    replace = false,
  ) =>
    setParams(writeSearchState(nextFilters, nextPage, nextLimit, nextView), {
      replace,
    });
  const changeView = (next) => {
    setPreference(next);
    try {
      localStorage.setItem("laborlens-results-view", next);
    } catch {
      /* The URL still retains the view if storage is unavailable. */
    }
    update(filters, page, limit, next, true);
  };
  const reset = () =>
    update(
      Object.fromEntries(Object.keys(filters).map((key) => [key, ""])),
      1,
      limit,
    );
  const scrollToResults = () => {
    resultsHeading.current?.focus({ preventScroll: true });
    resultsHeading.current?.scrollIntoView({
      block: "start",
      behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches
        ? "instant"
        : "smooth",
    });
  };
  const changePage = (next) => {
    update(filters, next);
    requestAnimationFrame(scrollToResults);
  };
  const count = data?.totalCount || 0;
  const totalPages = Math.max(1, data?.totalPages || 1);
  const currentPage = data?.currentPage || page;

  return (
    <section
      className="case-search-page"
      aria-label={`${config.label} case research`}
    >
      <div className="search-page-heading">
        <div>
          <h2>{config.title}</h2>
          <p>
            {config.subtitle}
          </p>
        </div>
        <details className="data-guide">
          <summary>About this data</summary>
          <div>
            <p>
              {config.description}
            </p>
            {config.dateExplanation && <p>{config.dateExplanation}</p>}
            <p>
              Year filters use the actual receipt or{" "}
              {config.event} date, not the disclosure’s
              fiscal year. Historical coverage is expanding; missing dates and
              pay periods are shown as not reported.
            </p>
            <a
              href="https://www.dol.gov/agencies/eta/foreign-labor/performance"
              target="_blank"
              rel="noreferrer"
            >
              View DOL disclosure files
            </a>
          </div>
        </details>
      </div>
      {program === "h1b" && <p className="inline-notice">DOL labor condition applications · case counts are applications, not workers or visa approvals.</p>}
      <details
        className={`search-controls${activeFilters.length ? " has-filters" : ""}`}
        key={`${program}-${filtersKey}`}
        open={wide || !activeFilters.length}
      >
        <summary>
          <FiSearch aria-hidden="true" />
          Edit search filters
        </summary>
        <SearchFilters
          key={`${program}-${filtersKey}-${params.size ? "filtered" : location.key}`}
          initialValues={filters}
          program={program}
          years={years}
          loading={loading}
          onSearch={(next) => {
            update(next, 1);
            requestAnimationFrame(scrollToResults);
          }}
          onClear={reset}
        />
      </details>
      {yearsError && (
        <p className="inline-notice" role="status">
          Year options are temporarily unavailable. The other search fields are
          still available.{" "}
          <button
            type="button"
            className="text-button"
            onClick={() => window.location.reload()}
          >
            Reload year options
          </button>
        </p>
      )}
      {activeFilters.length > 0 && (
        <div className="active-filters" aria-label="Applied filters">
          <FiSliders aria-hidden="true" />
          {activeFilters.map(([key, value]) => (
            <button
              className="filter-chip"
              key={key}
              onClick={() => update({ ...filters, [key]: "" }, 1)}
              aria-label={`Remove ${filterLabels[key]} filter ${value}`}
            >
              <span>
                {filterLabels[key]}: {value}
              </span>
              <FiX aria-hidden="true" />
            </button>
          ))}
          <button type="button" className="text-button" onClick={reset}>
            Clear filters
          </button>
        </div>
      )}
      <div className="results-toolbar" id="search-results">
        <div className="results-summary" aria-live="polite" aria-atomic="true">
          <h3 ref={resultsHeading} tabIndex={-1}>
            {loading
              ? "Searching cases…"
              : error
                ? "Results unavailable"
                : `${count.toLocaleString()} ${config.label} cases`}
          </h3>
          {data && (
            <p>
              {count && data.cases.length
                ? `${((currentPage - 1) * limit + 1).toLocaleString()}–${Math.min(currentPage * limit, count).toLocaleString()} shown`
                : count
                  ? "Page outside available results"
                  : "No matching records"}
              <span aria-hidden="true"> · </span>Newest{" "}
              {config.events} first
            </p>
          )}
        </div>
        <div className="result-controls">
          <button
            type="button"
            className="insights-toggle"
            aria-expanded={insightsOpen}
            aria-controls="search-insights"
            onClick={() => setInsightsOpen((value) => !value)}
          >
            <FiBarChart2 aria-hidden="true" />
            {insightsOpen ? "Hide insights" : "Explore insights"}
          </button>
          <div className="view-switch" role="group" aria-label="Results layout">
            <button
              type="button"
              aria-pressed={view === "table"}
              onClick={() => changeView("table")}
            >
              <FiList aria-hidden="true" />
              Table
            </button>
            <button
              type="button"
              aria-pressed={view === "cards"}
              onClick={() => changeView("cards")}
            >
              <FiGrid aria-hidden="true" />
              Cards
            </button>
          </div>
          <label className="page-size">
            Per page
            <select
              className="search-input"
              aria-label="Cases per page"
              value={limit}
              onChange={(event) =>
                update(filters, 1, Number(event.target.value))
              }
            >
              {PAGE_SIZES.map((size) => (
                <option key={size} value={size}>
                  {size}
                </option>
              ))}
            </select>
          </label>
        </div>
      </div>
      {insightsOpen && (
        <div id="search-insights">
          <Suspense fallback={<p className="inline-notice" role="status">Loading insights…</p>}>
            <SearchInsights
              program={program}
              filters={filters}
              onSelectYear={(year) => update({ ...filters, [config.yearKey]: String(year) }, 1)}
              onOverview={reset}
            />
          </Suspense>
        </div>
      )}
      <div aria-busy={loading} className="results-content">
        {loading ? (
          <div className={`results-skeleton skeleton-${view}`} role="status">
            <span className="sr-only">
              Loading {config.label} cases
            </span>
            {Array.from({ length: view === "table" ? 8 : 6 }, (_, index) => (
              <div className="skeleton-row" key={index}>
                <span />
                <span />
                <span />
              </div>
            ))}
          </div>
        ) : error ? (
          <div className="search-state" role="alert">
            <h3>Search is temporarily unavailable</h3>
            <p>{error}</p>
            <button
              type="button"
              className="btn"
              onClick={() => setRetry((value) => value + 1)}
            >
              <FiRefreshCw aria-hidden="true" />
              Try again
            </button>
          </div>
        ) : !count ? (
          <div className="search-state">
            <FiSearch aria-hidden="true" size={28} />
            <h3>No cases match this search</h3>
            <p>
              Try the start of an employer or job title, check the case number,
              or remove a year filter. Older disclosures may not report every
              date.
            </p>
            <button className="btn btn-secondary" type="button" onClick={reset}>
              Clear filters
            </button>
          </div>
        ) : !data.cases.length ? (
          <div className="search-state">
            <h3>This page has no cases</h3>
            <p>
              The available results may have changed. Return to the first page
              to continue.
            </p>
            <button
              type="button"
              className="btn"
              onClick={() => update(filters, 1)}
            >
              First page
            </button>
          </div>
        ) : (
          <CaseResults records={data.cases} program={program} view={view} />
        )}
      </div>
      {data && count > 0 && (
        <nav className="pagination" aria-label="Results pages">
          <button
            className="btn btn-secondary"
            onClick={() => changePage(currentPage - 1)}
            disabled={currentPage <= 1}
          >
            <FiArrowLeft aria-hidden="true" />
            Previous
          </button>
          <span className="page-info">
            Page <strong>{currentPage.toLocaleString()}</strong> of{" "}
            {totalPages.toLocaleString()}
          </span>
          <button
            className="btn btn-secondary"
            onClick={() => changePage(currentPage + 1)}
            disabled={currentPage >= totalPages}
          >
            Next
            <FiArrowRight aria-hidden="true" />
          </button>
        </nav>
      )}
    </section>
  );
}
