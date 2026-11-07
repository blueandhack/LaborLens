import { FiDownload, FiExternalLink } from 'react-icons/fi';
import { formatCount, issueLabel, reportIssues, validationOutcome } from '../utils/importPresentation';

const showValue = value => value == null ? '—' : typeof value === 'object' ? JSON.stringify(value) : String(value);

export default function ValidationReport({ source, reportId, onClose }) {
    const report = source.validation;
    const outcome = validationOutcome(report);
    const issues = reportIssues(report);
    const missing = Object.entries(report.missingValues || {}).filter(([, count]) => count > 0).sort((a, b) => b[1] - a[1]);
    const download = () => {
        const url = URL.createObjectURL(new Blob([JSON.stringify(source, null, 2)], { type: 'application/json' }));
        const link = document.createElement('a');
        link.href = url;
        link.download = (source.filename || 'dataset.xlsx').replace(/\.xlsx$/i, '-validation.json');
        link.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
    };
    return <section className="validation-report" id={reportId} aria-label={`Validation report for ${source.filename}`}>
        <div className="admin-section-heading">
            <div><p className="section-kicker">Full-file preflight · version {report.version ?? 'unreported'}</p><h4>Validation report</h4></div>
            <div className="admin-actions"><button className="btn btn-secondary" onClick={download}><FiDownload /> Export JSON</button><button className="admin-text-button" onClick={onClose}>Close report</button></div>
        </div>
        <p className={`import-notice ${outcome.tone}`}>{outcome.label}. {outcome.tone === 'error' ? (report.blockingReason || 'This file did not pass the preflight required before case writes.') : outcome.tone === 'warning' ? 'Invalid optional values are retained with the original record for review.' : 'Validation is a preflight check; see the file status for the import result.'}</p>
        <dl className="validation-metrics">
            {[['Rows scanned', report.rows], ['Valid case rows', report.validRows], ['Unique cases', report.uniqueCases], ['Rejected rows', report.rejectedRows], ['Duplicate rows', report.duplicateRows], ['Identical repeats', report.identicalDuplicates], ['Cases with variants', report.variantCases], ['Same-event variants', report.sameEventVariantCases]].map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{formatCount(value)}</dd></div>)}
        </dl>
        <p className="admin-help">Duplicates select the latest recorded decision or review event. Distinct alternate records are retained with the case.</p>
        {report.derivedFields?.VISA_CLASS > 0 && <p className="import-notice">For {formatCount(report.derivedFields.VISA_CLASS)} H-1B rows, visa class was decoded from the DOL iCERT case-number program ID because this fingerprinted FY2010 workbook omits the column. Each record retains the derivation and its source reference. Missing wage periods remain unreported.</p>}
        <div className="report-section"><h5>Source data issues</h5>
            {issues.length ? <div className="admin-table-scroll"><table className="admin-table"><thead><tr><th>Field</th><th>Issue</th><th>Occurrences</th><th>Resolved</th></tr></thead><tbody>{issues.map(issue => <tr key={issue.code}><td className="mono">{issue.field}</td><td>{issue.reason}</td><td>{formatCount(issue.count)}</td><td>{formatCount(issue.resolved)}</td></tr>)}</tbody></table></div> : <p className="admin-help">No field-format issues recorded.</p>}
        </div>
        {report.examples?.length > 0 && <div className="report-section"><h5>Example rows</h5><p className="admin-help">Up to 10 examples are saved per file. Issue counts above cover the full scan.</p>
            <div className="admin-table-scroll"><table className="admin-table"><thead><tr><th>Sheet / row</th><th>Field</th><th>Issue</th><th>Original value</th></tr></thead><tbody>{report.examples.map((example, index) => <tr key={index}><td>{example.row}</td><td className="mono">{example.field || 'CASE_NUMBER'}</td><td>{issueLabel(example.reason)}{example.resolution && <p className="admin-help">Resolved: {example.resolution.reason}</p>}</td><td className="report-original-value">{showValue(example.value)}</td></tr>)}</tbody></table></div>
        </div>}
        <details className="report-section"><summary>Missing values{missing.length ? ` · ${missing.length} fields` : ''}</summary><p className="admin-help">Missing values are reported separately from invalid values. Optional fields may be blank.</p>
            {missing.length ? <div className="admin-table-scroll"><table className="admin-table"><thead><tr><th>Field</th><th>Rows without a value</th></tr></thead><tbody>{missing.map(([field, count]) => <tr key={field}><td className="mono">{field}</td><td>{formatCount(count)}</td></tr>)}</tbody></table></div> : <p className="admin-help">No missing values recorded.</p>}
        </details>
        <details className="report-section"><summary>Workbook structure & field mapping</summary>
            <p className="admin-help">{formatCount(report.blankRows)} blank rows skipped · {formatCount(report.repeatedHeaders)} repeated headers skipped · {formatCount(report.excludedRows ?? 0)} non-H-1B rows excluded</p>
            {Object.keys(report.excludedVisaClasses || {}).length > 0 && <p className="admin-help">Excluded visa classes: {Object.entries(report.excludedVisaClasses).map(([type, count]) => `${type}: ${formatCount(count)}`).join(' · ')}</p>}
            {report.layouts?.map((layout, index) => <div className="report-layout" key={index}><h5>{layout.sheet}</h5><p className="admin-help">{layout.headers?.length || 0} source columns · {layout.missing?.length || 0} unmapped fields</p>
                {layout.missing?.length > 0 && <p className="admin-help">Unmapped: {layout.missing.join(', ')}</p>}
                <div className="admin-table-scroll"><table className="admin-table"><thead><tr><th>Application field</th><th>Source column</th></tr></thead><tbody>{Object.entries(layout.mapped || {}).map(([field, original]) => <tr key={field}><td className="mono">{field}</td><td className="mono">{original}</td></tr>)}</tbody></table></div>
            </div>)}
        </details>
        <details className="report-section"><summary>Source & full report</summary><a href={source.url} target="_blank" rel="noreferrer">Original DOL workbook <FiExternalLink /></a>
            {(report.sha256 || source.sha256) && <p className="admin-help report-hash">SHA-256: {report.sha256 || source.sha256}</p>}
            <pre className="report-json">{JSON.stringify(source, null, 2)}</pre>
        </details>
    </section>;
}
