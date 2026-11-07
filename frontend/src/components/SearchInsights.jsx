import { useEffect, useId, useState } from "react";
import { programs } from "../utils/programs";
import { getJSON } from "../utils/api";
import { calendarSeries, outcomeTicks, statusLabel } from "../utils/insights";
import "./SearchInsights.css";

const number = (value) => value.toLocaleString();
const compact = (value) => Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 }).format(value);
const percentage = (count, total) => total ? `${(count / total * 100).toLocaleString(undefined, { maximumFractionDigits: 1 })}%` : "0%";

// Lieflat Basics F2: calendar floor, hairline path, dots and separated peak labels.
function DecisionTrend({ data, program, onSelectYear }) {
  const config = programs[program];
  const titleId = useId();
  const descriptionId = useId();
  const series = calendarSeries(data.timeline);
  const max = Math.max(1, ...series.map((row) => row.count));
  const x = (i) => series.length === 1 ? 300 : 64 + i / (series.length - 1) * 468;
  const y = (count) => 208 - count / max * 154;
  const peaks = [];
  for (const i of series.map((_, i) => i).sort((a, b) => series[b].count - series[a].count)) {
    if (series[i].count > 0 && peaks.every((other) => Math.abs(x(other) - x(i)) > 100)) peaks.push(i);
    if (peaks.length === 2) break;
  }
  const labelEvery = Math.max(1, Math.ceil(series.length / 6));
  const event = config.events;
  return (
    <figure className="insight-figure">
      <figcaption>
        <h4>{program === "h1b" ? "Latest recorded actions" : program === "perm" ? "Decisions" : "Determinations"} over time</h4>
        <p>Cases by calendar year · {config.dateLabel.toLowerCase()}</p>
      </figcaption>
      {series.length ? (
        <div className="insight-plot-scroll">
          <svg className="insight-trend" viewBox="0 0 568 260" role="group" aria-labelledby={`${titleId} ${descriptionId}`}>
            <title id={titleId}>Imported {event} by year</title>
            <desc id={descriptionId}>Zero-based count axis. Select a year to filter cases. The data table below includes every value.</desc>
            {[0, 0.5, 1].map((fraction) => (
              <g key={fraction} className="insight-axis">
                <line x1="60" x2="540" y1={y(max * fraction)} y2={y(max * fraction)} />
                <text x="52" y={y(max * fraction) + 4} textAnchor="end">{compact(max * fraction)}</text>
              </g>
            ))}
            <path className="insight-line" d={series.map((row, i) => `${i ? "L" : "M"}${x(i)},${y(row.count)}`).join(" ")} />
            {series.map((row, i) => (
              <g key={row.year}>
                <line className="insight-calendar-tick" x1={x(i)} x2={x(i)} y1="208" y2="201" />
                {(i % labelEvery === 0 || i === series.length - 1) &&
                  <text className="insight-year-label" x={x(i)} y="235" textAnchor="middle">{row.year}</text>}
                {peaks.includes(i) && <text className="insight-peak" x={x(i)} y={y(row.count) - 14} textAnchor="middle">{compact(row.count)}</text>}
                <a href={`#year-${row.year}`} onClick={(event) => { event.preventDefault(); onSelectYear(row.year); }}
                  aria-label={`Filter ${row.year}: ${number(row.count)} cases`}>
                  <title>{row.year}: {number(row.count)} cases · select to filter</title>
                  <circle className="insight-hit" cx={x(i)} cy={y(row.count)} r="12" />
                  <circle className="insight-point" cx={x(i)} cy={y(row.count)} r={peaks.includes(i) ? 4 : 2.5} />
                </a>
              </g>
            ))}
          </svg>
        </div>
      ) : <p className="insight-empty">No usable {config.event} dates in these cases.</p>}
      <p className="insight-chart-note">Select a year to filter. {number(data.missingDateCount)} cases without a usable date are excluded from this chart.</p>
      <p className="insight-source">Source: U.S. Department of Labor disclosures</p>
    </figure>
  );
}

// Lieflat Basics F5: category queues, fifty tick slots, every fifth marked.
function CaseOutcomes({ data }) {
  return (
    <figure className="insight-figure">
      <figcaption>
        <h4>Reported case outcomes</h4>
        <p>Reported case status · share of all matching cases</p>
      </figcaption>
      <ul className="insight-outcomes" aria-label="Case outcomes">
        {data.outcomes.map((row) => (
          <li key={`${row.other ? "group" : "status"}-${row.status}`}>
            <div className="insight-outcome-label">
              <span>{statusLabel(row.status)}</span>
              <span><strong>{number(row.count)}</strong> <small>{percentage(row.count, data.totalCount)}</small></span>
            </div>
            <svg viewBox="0 0 300 24" className="insight-ticks" aria-hidden="true">
              <line className="insight-guide" x1="0" x2="300" y1="17" y2="17" />
              {outcomeTicks(row.count, data.totalCount).map((fraction, i) => (
                <g key={i}>
                  <rect x={i * 6 + 2} y="3" width={2 * fraction} height="14" />
                  {i % 5 === 4 && <circle className="insight-fifth" cx={i * 6 + 3} cy="22" r="1" />}
                </g>
              ))}
            </svg>
          </li>
        ))}
      </ul>
      {!data.totalCount && <p className="insight-empty">No matching cases to summarize.</p>}
      <p className="insight-chart-note">One full tick = 2% of cases. Partial ticks show the remainder. Statuses retain DOL’s distinctions.</p>
      <p className="insight-source">Source: U.S. Department of Labor disclosures</p>
    </figure>
  );
}

export default function SearchInsights({ program, filters, onSelectYear, onOverview }) {
  const [response, setResponse] = useState({ key: null });
  const [retry, setRetry] = useState(0);
  const query = new URLSearchParams(Object.entries(filters).filter(([, value]) => value)).toString();
  const endpoint = programs[program].endpoint + "/insights";
  const key = `${endpoint}?${query}&retry=${retry}`;
  const loading = response.key !== key;
  const data = !loading && response.data;
  useEffect(() => {
    const controller = new AbortController();
    getJSON(`${endpoint}?${query}${query ? "&" : ""}retry=${retry}`, { signal: controller.signal })
      .then((data) => { if (!controller.signal.aborted) setResponse({ key, data }); })
      .catch((error) => { if (!controller.signal.aborted) setResponse({ key, error: error.message }); });
    return () => controller.abort();
  }, [endpoint, query, key, retry]);
  return (
    <section className="search-insights" aria-label="Search insights" aria-busy={loading}>
      <div className="insights-heading">
        <div>
          <span className="insight-eyebrow">{query ? "Current search" : `All imported ${programs[program].label} data`}</span>
          <h3>{data ? `${number(data.totalCount)} cases, in context` : "Search insights"}</h3>
        </div>
        {query && <button type="button" className="text-button" onClick={onOverview}>Explore all {programs[program].label} data</button>}
      </div>
      {loading ? <p className="insights-message" role="status">Analyzing all matching cases…</p>
        : response.error ? <div className="insights-message" role="alert"><p>{response.error}</p><button type="button" className="text-button" onClick={() => setRetry((value) => value + 1)}>Retry insights</button></div>
        : data && <>
          <p className="insights-coverage">{query ? "All matching cases, across every page. " : "All imported cases for this program. "}Historical coverage is expanding. These counts are not annual application totals. A gap means no matching imported records.</p>
          {program === "h1b" && <p className="insights-coverage">Each application is counted once at its last recorded action, including withdrawals. This timeline describes case events rather than certification processing time. An application may request multiple workers.</p>}
          <p className="insights-asof">{data.source === "snapshot" ? "Dataset overview as of " : "Search analyzed "}<time dateTime={data.generatedAt}>{new Date(data.generatedAt).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}</time>{data.stale ? " · New data is awaiting the next overview refresh." : ""}</p>
          <div className="insights-charts">
            <DecisionTrend data={data} program={program} onSelectYear={onSelectYear} />
            <CaseOutcomes data={data} />
          </div>
          <details className="insight-data">
            <summary>View chart data</summary>
            <div className="insight-data-tables">
              <table><caption>{programs[program].yearLabel}s</caption><thead><tr><th scope="col">Year</th><th scope="col">Cases</th></tr></thead><tbody>
                {calendarSeries(data.timeline).map((row) => <tr key={row.year}><th scope="row"><button className="text-button" type="button" onClick={() => onSelectYear(row.year)}>{row.year}</button></th><td>{number(row.count)}</td></tr>)}
                <tr><th scope="row">Date not reported / unusable</th><td>{number(data.missingDateCount)}</td></tr>
              </tbody></table>
              <table><caption>Case outcomes</caption><thead><tr><th scope="col">Status</th><th scope="col">Cases</th><th scope="col">Share</th></tr></thead><tbody>
                {data.outcomes.map((row) => <tr key={`${row.other}-${row.status}`}><th scope="row">{statusLabel(row.status)}</th><td>{number(row.count)}</td><td>{percentage(row.count, data.totalCount)}</td></tr>)}
              </tbody></table>
            </div>
          </details>
        </>}
    </section>
  );
}
