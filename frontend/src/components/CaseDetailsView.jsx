import { useEffect, useRef, useState } from "react";
import { Link, useLocation, useParams } from "react-router-dom";
import { getJSON } from "../utils/api";
import {
  FiArrowLeft,
  FiExternalLink,
  FiMapPin,
  FiRefreshCw,
} from "react-icons/fi";
import { programs } from "../utils/programs";
import { StatusBadge } from "./CaseResults";
import { presentCase, formatCaseDate } from "../utils/casePresentation";

const FIELD_LABELS = {
  CASE_NUMBER: "Case number",
  CASE_STATUS: "Case status",
  ORIGINAL_CERT_DATE: "Original certification date",
  EMP_BUSINESS_NAME: "Employer name",
  EMPLOYER_LEGAL_BUSINESS_NAME: "Employer legal name",
  EMP_CITY: "Employer city",
  EMP_STATE: "Employer state",
  JOB_OPP_PWD_NUMBER: "Related PWD case number",
  JOB_OPP_WAGE_FROM: "Offered wage from",
  JOB_OPP_WAGE_TO: "Offered wage to",
  JOB_OPP_WAGE_PER: "Offered wage pay period",
  PWD_WAGE_RATE: "Prevailing wage rate",
  PWD_UNIT_OF_PAY: "Prevailing wage pay period",
  PWD_SOC_CODE: "Occupation code (SOC)",
  PWD_SOC_TITLE: "Occupation title (SOC)",
};
const fieldLabel = (key, program) =>
  (program === "h1b" && key === "DECISION_DATE" ? "Last recorded action date"
    : program === "h1b" && key === "RECEIVED_DATE" ? "DOL received date" : FIELD_LABELS[key]) ||
  key
    .split("_")
    .map((word) =>
      ["PWD", "SOC", "OES", "NAICS", "H1B", "H2B", "FEIN", "ZIP"].includes(word)
        ? word
        : word.charAt(0) + word.slice(1).toLowerCase(),
    )
    .join(" ");
const visibleEntries = (record) =>
  Object.entries(record).filter(
    ([key, value]) =>
      !["_id", "__v", "score", "createdAt", "updatedAt", "_PROGRAM"].includes(key) &&
      !key.startsWith("_DOL_") &&
      !key.endsWith("_LOWER") &&
      value != null &&
      value !== "",
  );
function Field({ entry: [key, value], raw = false, program }) {
  const display =
    !raw &&
    key.includes("DATE") &&
    typeof value === "string" &&
    /^\d{4}-\d{2}-\d{2}T/.test(value)
      ? formatCaseDate(value)
      : typeof value === "object"
        ? JSON.stringify(value)
        : String(value);
  return (
    <div className="detail-item">
      <dt className="detail-key" title={key}>
        {fieldLabel(key, program)}
      </dt>
      <dd
        className={`detail-value${/CODE|NUMBER|NAICS/.test(key) ? " mono" : ""}`}
      >
        {display}
      </dd>
    </div>
  );
}

export default function CaseDetailsView() {
  const { id } = useParams();
  const location = useLocation();
  const [response, setResponse] = useState({
    key: null,
    data: null,
    error: null,
  });
  const [retry, setRetry] = useState(0);
  const requestKey = `${id}-${retry}`;
  const heading = useRef(null);
  useEffect(() => {
    const controller = new AbortController();
    let current = true;
    getJSON(`/api/cases/${id}`, { signal: controller.signal })
      .then((data) => {
        if (current) setResponse({ key: requestKey, data, error: null });
      })
      .catch((error) => {
        if (current && !controller.signal.aborted)
          setResponse({
            key: requestKey,
            data: null,
            error: error.status === 404 ? "missing" : "failed",
          });
      });
    return () => {
      current = false;
      controller.abort();
    };
  }, [id, requestKey]);
  const item = response.key === requestKey ? response.data : null;
  useEffect(() => {
    window.scrollTo(0, 0);
  }, [id]);
  useEffect(() => {
    document.title = item
      ? `${item.CASE_NUMBER} | LaborLens`
      : "Case details | LaborLens";
    if (item) heading.current?.focus({ preventScroll: true });
  }, [item]);
  const program = item?._PROGRAM || item?._DOL_SOURCE?.type ||
    (item?.EMPLOYER_NAME ? "h1b" : item?.EMP_BUSINESS_NAME ? "perm" : "pwd");
  const perm = program !== "pwd";
  const from = location.state?.from;
  const back = typeof from === "string" && /^\/(?:\?.*|(?:perm|h1b)(?:\?.*)?)?$/.test(from)
    ? from : program === "pwd" ? "/" : `/${program}`;
  if (response.key !== requestKey)
    return (
      <div className="loading-overlay" role="status">
        <div className="spinner-large" />
        <h2>Loading case details</h2>
      </div>
    );
  if (!item || response.error)
    return (
      <div className="search-state" role="alert">
        <h2>
          {response.error === "missing"
            ? "Case not found"
            : "Couldn’t load this case"}
        </h2>
        <p>
          {response.error === "missing"
            ? "This case is not available in the database."
            : "The connection failed. You can retry or return to your search."}
        </p>
        {response.error !== "missing" && (
          <button
            className="btn"
            onClick={() => setRetry((value) => value + 1)}
          >
            <FiRefreshCw aria-hidden="true" />
            Try again
          </button>
        )}
        <Link className="btn btn-secondary" to={back}>
          <FiArrowLeft aria-hidden="true" />
          Back to results
        </Link>
      </div>
    );
  const data = presentCase(item, program);
  const entries = visibleEntries(item);
  const grouped = [
    {
      name: program === "h1b" ? "Case history and dates" : "Case and processing",
      matches: (key) =>
        /^(CASE_|VISA_|RECEIVED_|DECISION_|DETERMINATION_|REDETERMINATION_|WITHDRAWAL_|CENTER_|ORIGINAL_)/.test(
          key,
        ),
    },
    { name: "Employer", matches: (key) => /^(EMPLOYER_|EMP_)/.test(key) },
    {
      name: "Job, worksite, and wages",
      matches: (key) =>
        /^(JOB_|PWD_|PW_|WORKSITE_|WAGE_|SOC_|ALT_|BLS_|H2B_)/.test(key),
    },
    {
      name: "Agent and attorney",
      matches: (key) => /^(AGENT_|ATTORNEY_)/.test(key),
    },
  ];
  const groups = [
    ...grouped.map((group) => ({
      ...group,
      entries: entries.filter(([key]) => group.matches(key)),
    })),
    {
      name: "Other reported information",
      entries: entries.filter(
        ([key]) => !grouped.some((group) => group.matches(key)),
      ),
    },
  ].filter((group) => group.entries.length);
  const issues = Object.entries({
    ...item._DOL_RAW_VALUES,
    ...item._DOL_CELL_ERRORS,
  });
  const variants = item._DOL_ALTERNATE_RECORDS || [];
  const source = item._DOL_SOURCE || item._DOL_SUPPLEMENT_SOURCE;
  return (
    <article className="case-details-page">
      <Link className="back-to-results" to={back}>
        <FiArrowLeft aria-hidden="true" />
        Back to results
      </Link>
      <header className="case-details-header">
        <div className="case-detail-meta">
          <span className="section-kicker">
            {programs[program].label} disclosure
          </span>
          <span className="mono">{item.CASE_NUMBER}</span>
          <StatusBadge status={data.status} statusClass={data.statusClass} />
        </div>
        <h2 ref={heading} tabIndex={-1}>
          {data.employer}
        </h2>
        <p className="detail-job-title">{data.title}</p>
        <p className="detail-location">
          <FiMapPin aria-hidden="true" />
          {data.location}
          {item.VISA_CLASS && <span>{item.VISA_CLASS}</span>}
        </p>
      </header>
      {program === "h1b" && <p className="source-note">{programs.h1b.description}</p>}
      <dl className="case-overview">
        <div>
          <dt>{programs[program].wageLabel}</dt>
          <dd>{data.wage === "N/A" ? "Not reported" : data.wage}</dd>
          {item.PWD_OES_WAGE_LEVEL && <span>{item.PWD_OES_WAGE_LEVEL}</span>}
        </div>
        <div>
          <dt>{programs[program].receivedLabel}</dt>
          <dd>{formatCaseDate(item.RECEIVED_DATE)}</dd>
        </div>
        <div>
          <dt>{programs[program].dateLabel}</dt>
          <dd>{formatCaseDate(data.eventDate)}</dd>
        </div>
        {program === "h1b" ? <div>
          <dt>Original certification</dt>
          <dd>{data.originalCertificationDate ? formatCaseDate(data.originalCertificationDate) : "Not separately reported"}</dd>
        </div> : <div>
          <dt>Receipt to {perm ? "decision" : "determination"}</dt>
          <dd>{data.elapsed === null ? "Not reported" : `${data.elapsed.toLocaleString()} calendar days`}</dd>
        </div>}
      </dl>
      {program === "h1b" && <p className="source-note">{programs.h1b.dateExplanation}</p>}
      {source?.url && (
        <p className="source-note">
          Source:{" "}
          <a href={source.url} target="_blank" rel="noreferrer">
            DOL disclosure, FY{source.fiscalYear}
            <FiExternalLink aria-hidden="true" />
          </a>
          . Missing historical values have not been inferred.
        </p>
      )}
      {issues.length > 0 && (
        <details className="source-records source-warning">
          <summary>
            Unavailable or invalid source values ({issues.length})
          </summary>
          <p>
            These values could not be interpreted reliably. Their original
            contents are preserved below.
          </p>
          <dl className="details-grid">
            {issues.map((entry) => (
              <Field raw program={program} key={entry[0]} entry={entry} />
            ))}
          </dl>
        </details>
      )}
      {program === "perm" && item.JOB_OPP_PWD_NUMBER && (
        <p className="source-note">
          <Link
            className="related-pwd-link"
            to={`/?caseNumber=${encodeURIComponent(item.JOB_OPP_PWD_NUMBER)}`}
          >
            Find related PWD case {item.JOB_OPP_PWD_NUMBER}
          </Link>
        </p>
      )}
      <nav
        className="detail-section-nav"
        aria-label="Case information sections"
      >
        {groups.map((group, index) => (
          <a key={group.name} href={`#case-section-${index}`}>
            {group.name}
          </a>
        ))}
      </nav>
      {groups.map((group, index) => (
        <section
          key={group.name}
          className="detail-section"
          id={`case-section-${index}`}
        >
          <h3>{group.name}</h3>
          <dl className="details-grid">
            {group.entries.map((entry) => (
              <Field program={program} key={entry[0]} entry={entry} />
            ))}
          </dl>
        </section>
      ))}
      {variants.length > 0 && (
        <details className="source-records">
          <summary>
            Additional source records or worksites ({variants.length})
          </summary>
          <p>
            The primary record uses the latest recorded event. Differing rows
            from the same disclosure are retained below.
          </p>
          {variants.map((variant) => (
            <dl className="details-grid alternate-record" key={variant.row}>
              {visibleEntries(variant.data).map((entry) => (
                <Field program={program} key={entry[0]} entry={entry} />
              ))}
            </dl>
          ))}
        </details>
      )}
    </article>
  );
}
