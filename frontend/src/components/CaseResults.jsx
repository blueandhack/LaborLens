import { Link, useLocation } from "react-router-dom";
import { FiArrowUpRight, FiMapPin } from "react-icons/fi";
import { presentCase, formatCaseDate } from "../utils/casePresentation";

export function StatusBadge({ status, statusClass }) {
  return (
    <span className={`status-badge status-badge-${statusClass}`}>{status}</span>
  );
}

export default function CaseResults({ records, program, view }) {
  const location = useLocation();
  const from = location.pathname + location.search;
  const perm = program === "perm";
  const dateLabel = perm ? "Decision date" : "Determination date";
  const wageLabel = perm ? "Offered wage" : "Prevailing wage";
  if (view === "table")
    return (
      <div className="table-result-frame">
        <p className="table-scroll-note">
          Scroll within the table to see all columns. Employer and case numbers
          stay visible.
        </p>
        <div
          className="table-scroll"
          role="region"
          aria-label={`${program.toUpperCase()} results, scrollable table`}
          tabIndex={0}
        >
          <table className="case-table">
            <caption className="sr-only">
              {program.toUpperCase()} cases, newest{" "}
              {perm ? "decisions" : "determinations"} first. Open a case for its
              complete disclosure.
            </caption>
            <colgroup>
              <col className="col-employer" />
              <col className="col-job" />
              <col className="col-location" />
              <col className="col-wage" />
              <col className="col-status" />
              <col className="col-date" />
              <col className="col-date" />
            </colgroup>
            <thead>
              <tr>
                <th scope="col">Employer / case</th>
                <th scope="col">Job / occupation</th>
                <th scope="col">Employer location</th>
                <th scope="col">{wageLabel}</th>
                <th scope="col">Case status</th>
                <th scope="col">Received</th>
                <th scope="col">{dateLabel}</th>
              </tr>
            </thead>
            <tbody>
              {records.map((record) => {
                const data = presentCase(record, program);
                return (
                  <tr key={record._id}>
                    <th scope="row">
                      <Link
                        className="result-case-link"
                        to={`/cases/${record._id}`}
                        state={{ from }}
                        aria-label={`View ${program.toUpperCase()} case ${record.CASE_NUMBER}: ${data.employer}, ${data.title}, ${data.status}`}
                      >
                        <span className="result-employer">{data.employer}</span>
                        <span className="result-case-number mono">
                          {record.CASE_NUMBER || "View case"}{" "}
                          <FiArrowUpRight aria-hidden="true" />
                        </span>
                      </Link>
                    </th>
                    <td>
                      <span className="result-job">{data.title}</span>
                      {record.PWD_SOC_CODE && (
                        <span
                          className="cell-secondary"
                          title={record.PWD_SOC_TITLE}
                        >
                          SOC {record.PWD_SOC_CODE}
                          {record.PWD_SOC_TITLE && ` · ${record.PWD_SOC_TITLE}`}
                        </span>
                      )}
                    </td>
                    <td>
                      <span>{data.location}</span>
                      {record.VISA_CLASS && (
                        <span className="cell-secondary">
                          {record.VISA_CLASS}
                        </span>
                      )}
                    </td>
                    <td>
                      <span className="result-wage">
                        {data.wage === "N/A" ? "Not reported" : data.wage}
                      </span>
                      {record.PWD_OES_WAGE_LEVEL && (
                        <span className="cell-secondary">
                          {record.PWD_OES_WAGE_LEVEL}
                        </span>
                      )}
                      {perm && record.JOB_OPP_PWD_NUMBER && (
                        <Link
                          className="cell-secondary related-pwd-link"
                          to={`/?caseNumber=${encodeURIComponent(record.JOB_OPP_PWD_NUMBER)}`}
                        >
                          Find PWD {record.JOB_OPP_PWD_NUMBER}
                        </Link>
                      )}
                    </td>
                    <td>
                      <StatusBadge
                        status={data.status}
                        statusClass={data.statusClass}
                      />
                    </td>
                    <td className="date-cell">
                      {formatCaseDate(record.RECEIVED_DATE)}
                    </td>
                    <td className="date-cell">
                      {formatCaseDate(data.eventDate)}
                      {data.elapsed !== null && (
                        <span className="cell-secondary">
                          {data.elapsed.toLocaleString()} days after receipt
                        </span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    );
  return (
    <div className="results-grid">
      {records.map((record) => {
        const data = presentCase(record, program);
        return (
          <Link
            className="case-card-link"
            key={record._id}
            to={`/cases/${record._id}`}
            state={{ from }}
            aria-label={`View ${program.toUpperCase()} case ${record.CASE_NUMBER}: ${data.employer}, ${data.title}, ${data.status}`}
          >
            <article className={`case-card status-${data.statusClass}`}>
              <div className="card-status-row">
                <StatusBadge
                  status={data.status}
                  statusClass={data.statusClass}
                />
                {record.VISA_CLASS && (
                  <span className="visa-tag">{record.VISA_CLASS}</span>
                )}
              </div>
              <h3 className="company-name">{data.employer}</h3>
              <p className="card-job-title">{data.title}</p>
              <p className="card-location">
                <FiMapPin aria-hidden="true" />
                {data.location}
              </p>
              <div className="card-wage">
                <span className="info-label">{wageLabel}</span>
                <strong>
                  {data.wage === "N/A" ? "Not reported" : data.wage}
                </strong>
                {record.PWD_OES_WAGE_LEVEL && (
                  <span className="cell-secondary">
                    {record.PWD_OES_WAGE_LEVEL}
                  </span>
                )}
              </div>
              <dl className="card-facts">
                <div>
                  <dt>Received</dt>
                  <dd>{formatCaseDate(record.RECEIVED_DATE)}</dd>
                </div>
                <div>
                  <dt>{dateLabel}</dt>
                  <dd>{formatCaseDate(data.eventDate)}</dd>
                </div>
                {data.elapsed !== null && (
                  <div>
                    <dt>Receipt to {perm ? "decision" : "determination"}</dt>
                    <dd>{data.elapsed.toLocaleString()} days</dd>
                  </div>
                )}
                {record.PWD_SOC_CODE && (
                  <div>
                    <dt>Occupation (SOC)</dt>
                    <dd title={record.PWD_SOC_TITLE}>{record.PWD_SOC_CODE}</dd>
                  </div>
                )}
              </dl>
              <div className="card-footer">
                <span className="case-number">{record.CASE_NUMBER}</span>
                <FiArrowUpRight aria-label="View case" />
              </div>
            </article>
          </Link>
        );
      })}
    </div>
  );
}
