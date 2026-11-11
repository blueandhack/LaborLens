import { caseSortOptions, readCaseSort } from '../utils/sorting';
import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { getJSON } from "../utils/api";
import { Link, useSearchParams, useLocation } from "react-router-dom";
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
import { STATES, stateName } from "../utils/states";
import EmployerAutocomplete from './EmployerAutocomplete';
import "./CaseSearchView.css";
import { programs } from "../utils/programs";
import {
  PAGE_SIZES,
  readSearchState,
  searchRequests,
  writeSearchState,
} from "../utils/searchState";

const SearchInsights = lazy(() => import("./SearchInsights"));

const savedView = () => {
  if (typeof window === 'undefined') return null;
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
  worksiteReady,
}) {
  const [draft, setDraft] = useState(initialValues);
  const [selectedEmployer, setSelectedEmployer] = useState(null);
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
        <div className="field-employer"><EmployerAutocomplete id="search-company" value={draft.company || draft.employer || ''}
          onChange={company => { setDraft(values => ({ ...values, company, employer: '', employerGroup: '' })); setSelectedEmployer(null); }}
          onSelect={employer => { setDraft(values => ({ ...values, company: employer.name.slice(0, 160), employer: employer.groupId ? '' : employer.key, employerGroup: employer.groupId || '' })); setSelectedEmployer(employer); }} />
          {(draft.employer || draft.employerGroup) && <p className="selected-employer-link">{draft.employerGroup ? 'Matching every combined filing name for this employer.' : 'Matching this reported name exactly.'}{selectedEmployer && <> <Link to={'/employers/' + selectedEmployer.slug}>View employer profile</Link></>}</p>}
        </div>
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
        <label htmlFor="search-worksite">Worksite location
          <input id="search-worksite" name="worksite" className="search-input" placeholder={!worksiteReady ? 'Worksite search preparing…' : draft.worksiteState ? 'Primary worksite city' : 'Primary worksite city or state'}
            value={draft.worksite || ''} onChange={edit('worksite')} disabled={!worksiteReady} autoComplete="off" />
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
            initialValues.worksiteState ||
            initialValues[yearKey] ||
            initialValues.receivedYear,
          )}
        >
          <summary>
            <FiSliders aria-hidden="true" />
            Case number, dates and worksite state
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
                aria-label={config.yearLabel}
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
            <label htmlFor="search-worksite-state">
              Worksite state
              <select id="search-worksite-state" name="worksiteState" className="search-input" value={draft.worksiteState || ''}
                onChange={edit("worksiteState")} disabled={!worksiteReady}>
                <option value="">Any state</option>
                {STATES.map(([code, name]) => <option key={code} value={code}>{name}</option>)}
              </select>
            </label>
            <label htmlFor="search-received-year">
              {config.receivedLabel} year
              <select
                id="search-received-year"
                name="receivedYear"
                aria-label={`${config.receivedLabel} year`}
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
        Search by the beginning of a name, title, city, or case number. Employer names tolerate punctuation and spacing differences. Combine
        fields to narrow your results.
        {' '}Employer location is the business address; worksite location is the reported primary worksite. With a worksite state selected, worksite location matches the city. Missing worksites are not inferred.
      </p>
    </form>
  );
}

export default function CaseSearchView({ program }) {
  const [params, setParams] = useSearchParams();
  const location = useLocation();
  const { filters, page, limit } = readSearchState(params, program);
  const sort = readCaseSort(params, program);
  const sortOptions = caseSortOptions(program);
  const sortLabel = sortOptions.find(option => option.value === sort).label;
  const [years, setYears] = useState([]);
  const [yearsError, setYearsError] = useState(false);
  const [worksites, setWorksites] = useState({});
  const [retry, setRetry] = useState(0);
  const [countRetry, setCountRetry] = useState(0);
  const [countResponse, setCountResponse] = useState({ key: null, totalCount: null, error: null });
  const [insightsOpen, setInsightsOpen] = useState(false);
  const [response, setResponse] = useState({
    key: null,
    data: null,
    error: null,
  });
  const [preference, setPreference] = useState(savedView);
  const [wide, setWide] = useState(
    () => typeof window !== 'undefined' && window.matchMedia("(min-width: 1280px)").matches,
  );
  const resultsHeading = useRef(null);
  const filtersPanel = useRef(null);
  const config = programs[program];
  const endpoint = config.endpoint;
  const requests = searchRequests(program, { filters, page, limit, sort });
  const { query, countQuery } = requests;
  const requestKey = `${endpoint}?${query}&retry=${retry}`;
  const countKey = `${endpoint}?${countQuery}&retry=${retry}`;
  const loading = response.key !== requestKey;
  const error = !loading && response.error;
  const data = !loading && !error ? response.data : null;
  // Keep an in-flight total across page/layout changes, but discard it when
  // filters change. A total must never delay or replace visible case results.
  const countEligible = response.countKey === countKey && Boolean(response.data) && response.data.totalCount == null;
  const viewParam = params.get("view");
  const view = ["table", "cards"].includes(viewParam)
    ? viewParam
    : ["table", "cards"].includes(preference)
      ? preference
      : wide
        ? "table"
        : "cards";
  const filtersKey = JSON.stringify(filters);
  const activeFilters = Object.entries(filters).filter(([key, value]) => value && !(key === 'company' && (filters.employer || filters.employerGroup)));
  const filterLabels = {
    company: "Employer",
    employer: "Reported name",
    employerGroup: "Employer",
    location: "Location",
    worksite: filters.worksiteState ? "Worksite city" : "Worksite",
    worksiteState: "Worksite state",
    caseNumber: "Case",
    jobTitle: "Job",
    determinationYear: "Determined",
    decisionYear: program === "h1b" ? "Last action" : "Decided",
    receivedYear: config.receivedLabel,
  };

  useEffect(() => {
    const controller = new AbortController();
    let timer;
    const load = () => getJSON('/api/employers/status', { signal: controller.signal, fresh: true }).then(data => {
      if (controller.signal.aborted) return;
      setWorksites(data.worksites || {});
      if (!data.worksites?.[program]?.ready) timer = setTimeout(load, 15000);
    }).catch(() => { if (!controller.signal.aborted) timer = setTimeout(load, 30000); });
    load();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [program]);

  useEffect(() => {
    const media = window.matchMedia("(min-width: 1280px)");
    const listener = (event) => setWide(event.matches);
    media.addEventListener("change", listener);
    return () => media.removeEventListener("change", listener);
  }, []);

  useEffect(() => {
    // A native details toggle can outlive its unchanged React open prop.
    // Reopen the desktop form when its compact toggle becomes hidden.
    if (wide && filtersPanel.current) filtersPanel.current.open = true;
  }, [wide]);

  useEffect(() => {
    const controller = new AbortController();
    let current = true;
    getJSON(requests.results, {
        signal: controller.signal,
      })
      .then((result) => {
        if (current)
          setResponse({ key: requestKey, countKey, data: result, error: null });
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
  }, [requests.results, requestKey, countKey]);

  useEffect(() => {
    if (!countEligible) return;
    const controller = new AbortController();
    getJSON(requests.count, { signal: controller.signal })
      .then((result) => {
        if (!controller.signal.aborted) setCountResponse({ key: countKey, totalCount: result.totalCount, error: null });
      })
      .catch(() => {
        if (!controller.signal.aborted) setCountResponse({ key: countKey, totalCount: null,
          error: "Total unavailable. You can still browse these results." });
      });
    return () => controller.abort();
  }, [requests.count, countKey, countEligible, countRetry]);

  useEffect(() => {
    const controller = new AbortController();
    getJSON(requests.years, { signal: controller.signal })
      .then((result) => {
        setYears(result);
        setYearsError(false);
      })
      .catch(() => {
        if (!controller.signal.aborted) setYearsError(true);
      });
    return () => controller.abort();
  }, [requests.years]);

  const update = (
    nextFilters = filters,
    nextPage = page,
    nextLimit = limit,
    nextView = viewParam,
    replace = false,
    nextSort = sort,
  ) =>
    setParams(writeSearchState(nextFilters, nextPage, nextLimit, nextView, nextSort), {
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
  const count = data?.totalCount ?? (countResponse.key === countKey ? countResponse.totalCount : null);
  const countError = count === null && countResponse.key === countKey && countResponse.error;
  const totalPages = count === null ? null : Math.max(1, Math.ceil(count / limit));
  const currentPage = data?.currentPage || page;
  const hasNextPage = data?.hasNextPage ?? (totalPages !== null && currentPage < totalPages);

  return (
    <section
      className="case-search-page"
      aria-label={`${config.label} case research`}
    >
      <div className="search-page-heading">
        <div>
          <h1>{config.title}</h1>
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
            <p><Link to="/data">Read our data sources and methodology</Link></p>
          </div>
        </details>
      </div>
      {program === "h1b" && <p className="inline-notice search-program-note">DOL labor condition applications · case counts are applications, not workers or visa approvals.</p>}
      <div className="search-workspace">
      <aside className="search-filter-panel" aria-label="Search filters">
      <div className="filter-panel-heading"><p className="section-kicker">Refine your results</p><h3>Search filters</h3></div>
      <details
        ref={filtersPanel}
        className={`search-controls${activeFilters.length ? " has-filters" : ""}`}
        key={`${program}-${filtersKey}`}
        open={wide || !activeFilters.length}
      >
        <summary>
          <FiSearch aria-hidden="true" />
          Search filters
          {activeFilters.length > 0 && <span className="filter-count">{activeFilters.length} applied</span>}
        </summary>
        <SearchFilters
          key={`${program}-${filtersKey}-${params.size ? "filtered" : location.key}`}
          initialValues={filters}
          program={program}
          years={years}
          loading={loading}
          worksiteReady={Boolean(worksites[program]?.ready)}
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
      </aside>
      <div className="search-results-panel">
      {activeFilters.length > 0 && (
        <div className="active-filters" aria-label="Applied filters">
          <FiSliders aria-hidden="true" />
          {activeFilters.map(([key, value]) => (
            <button
              className="filter-chip"
              key={key}
              onClick={() => update({ ...filters, [key]: "", ...(['employer', 'employerGroup'].includes(key) ? { company: '', employer: '', employerGroup: '' } : {}) }, 1)}
              aria-label={`Remove ${filterLabels[key]} filter ${key === 'employerGroup' ? filters.company || 'combined filing names' : value}`}
            >
              <span>
                {filterLabels[key]}: {key === 'employerGroup' ? filters.company || data?.employerGroup?.name || 'Combined filing names' : key === 'worksiteState' ? stateName(value) : value}
              </span>
              <FiX aria-hidden="true" />
            </button>
          ))}
          <button type="button" className="text-button" onClick={reset}>
            Clear filters
          </button>
        </div>
      )}
      {data?.employerGroup && <p className="inline-notice">Matching {data.employerGroup.names} combined filing names for {data.employerGroup.name}. <Link to={'/employers/' + data.employerGroup.slug}>View combined profile and source names</Link></p>}
      <div className="results-toolbar" id="search-results">
        <div className="results-summary" aria-live="polite" aria-atomic="true">
          <h3 ref={resultsHeading} tabIndex={-1}>
            {loading
              ? "Searching cases…"
              : error
                ? "Results unavailable"
                : `${count === null ? "" : `${count.toLocaleString()} `}${config.label} cases`}
          </h3>
          {data && (
            <p>
              {data.cases.length
                ? `${((currentPage - 1) * limit + 1).toLocaleString()}–${((currentPage - 1) * limit + data.cases.length).toLocaleString()} shown`
                : currentPage > 1
                  ? "Page outside available results"
                  : "No matching records"}
              <span aria-hidden="true"> · </span>{sortLabel}
            </p>
          )}
          {data && count === null && (
            <p className="result-count-status">
              {countError || "Counting total… You can browse now."}
              {countError && <> <button type="button" className="text-button" onClick={() => {
                setCountResponse({ key: null, totalCount: null, error: null });
                setCountRetry((value) => value + 1);
              }}>Retry total</button></>}
            </p>
          )}
        </div>
        <div className="result-controls">
          <label className="result-sort">Sort by
            <select className="search-input" aria-label="Sort cases" value={sort}
              onChange={event => update(filters, 1, limit, viewParam, false, event.target.value)}>
              {sortOptions.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
            </select>
          </label>
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
        </div>
      </div>
      {program === 'h1b' && sort.startsWith('certification_') && <p className="sort-explanation">Certification uses the determination date for Certified cases and the reported original certification date for other statuses. Missing certification dates appear last; withdrawal dates are not substituted.</p>}
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
        ) : !data.cases.length && currentPage === 1 ? (
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
          <CaseResults records={data.cases} program={program} view={view} sort={sort} sortLabel={sortLabel} />
        )}
      </div>
      {data && (data.cases.length > 0 || currentPage > 1) && (
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
            Page <strong>{currentPage.toLocaleString()}</strong>
            {totalPages !== null && <> of {totalPages.toLocaleString()}</>}
          </span>
          <button
            className="btn btn-secondary"
            onClick={() => changePage(currentPage + 1)}
            disabled={!hasNextPage}
          >
            Next
            <FiArrowRight aria-hidden="true" />
          </button>
        </nav>
      )}
      </div>
      </div>
      <footer className="search-data-note"><p>Free public DOL disclosure research. Wages retain their reported pay periods; historical coverage is expanding.</p><Link to="/data">Sources, coverage & methodology</Link></footer>
    </section>
  );
}
