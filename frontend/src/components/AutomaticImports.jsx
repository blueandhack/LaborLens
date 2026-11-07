import { useState } from 'react';
import { FiRefreshCw, FiExternalLink, FiChevronDown } from 'react-icons/fi';
import ReportLoader from './ValidationReportLoader';
import ImportCoverage from './ImportCoverage';
import { formatCount, formatImportDate, isProcessing, needsAttention, programLabel, sourceStatus } from '../utils/importPresentation';

export default function AutomaticImports({ status, error, refreshing, onRefresh }) {
    const [program, setProgram] = useState('all');
    const [state, setState] = useState('all');
    const [query, setQuery] = useState('');
    const [page, setPage] = useState(0);
    const [openReport, setOpenReport] = useState(null);
    const sources = status?.sources || [];
    const attention = sources.filter(needsAttention).length;
    const filtered = sources.filter(source => (program === 'all' || source.type === program)
        && (state === 'all' || (state === 'attention' ? needsAttention(source) : state === 'processing' ? isProcessing(source) : source.status === 'done'))
        && (source.filename || '').toLowerCase().includes(query.toLowerCase()));
    const currentPage = Math.min(page, Math.max(0, Math.ceil(filtered.length / 10) - 1));
    const visible = filtered.slice(currentPage * 10, (currentPage + 1) * 10);
    const coverage = status?.coverage;
    const latest = status?.currentRun || status?.runs?.find(run => run._id === status.active?.runId) || status?.runs?.[0];
    const changeFilter = (setter, value) => { setter(value); setPage(0); setOpenReport(null); };
    const closeReport = id => { setOpenReport(null); document.getElementById(`report-toggle-${id}`)?.focus(); };

    return <section className="automatic-imports" aria-labelledby="automatic-imports-heading">
        <div className="admin-section-heading"><div><h3 id="automatic-imports-heading">Automatic imports</h3><p className="admin-help">DOL releases are checked on a schedule and validated before import.</p></div>
            <button className="btn btn-secondary" onClick={onRefresh} disabled={refreshing}><FiRefreshCw className={refreshing ? 'is-refreshing' : ''} />{refreshing ? 'Refreshing…' : 'Refresh status'}</button>
        </div>
        {error && <p role="alert" className="import-notice error">{error} {status ? 'Showing the last loaded status.' : 'Use Refresh status to try again.'}</p>}
        {!status && !error ? <div className="admin-status-loading" role="status">Loading import status and file history…</div> : status && <>
            <div className="import-run-context"><span>{status.active ? `${status.active.label} is active.` : 'No automatic import is currently running.'}</span>{latest && <span>Latest check: {formatImportDate(latest.startedAt)} · {latest.status}</span>}</div>
            {attention > 0 && <p className="import-notice warning">{attention} {attention === 1 ? 'file needs' : 'files need'} attention. <button className="admin-text-button" onClick={() => { setProgram('all'); setQuery(''); changeFilter(setState, 'attention'); }}>Review files needing attention</button></p>}
            {latest?.status === 'error' && latest.error && <p className="import-notice error">Latest run: {latest.error}</p>}
        </>}
        <div className="admin-monitor-layout">
        {status?.progress && <ImportCoverage progress={status.progress} sources={sources} />}
        <section className="import-history-section" aria-labelledby="import-history-heading">
        <div className="admin-section-heading history-heading"><div><h3 id="import-history-heading">File history</h3><p className="admin-help">Open a validation report to inspect issues and example rows here.</p></div></div>
        <div className="import-history-filters">
            <label>Find a file<input type="search" placeholder="Search filename…" className="search-input" value={query} onChange={event => changeFilter(setQuery, event.target.value)} /></label>
            <label><span id="import-program-label">Program</span><select aria-labelledby="import-program-label" className="search-input" value={program} onChange={event => changeFilter(setProgram, event.target.value)}><option value="all">All programs</option>{['pwd', 'perm', 'h1b'].map(type => <option key={type} value={type}>{programLabel(type)}</option>)}</select></label>
            <label><span id="import-status-label">Status</span><select aria-labelledby="import-status-label" className="search-input" value={state} onChange={event => changeFilter(setState, event.target.value)}><option value="all">All statuses</option><option value="attention">Needs attention</option><option value="processing">In progress</option><option value="done">Completed</option></select></label>
        </div>
        {visible.length > 0 ? <div className="import-history">{visible.map(source => <div className={`import-history-item ${openReport === source._id ? 'has-report' : ''}`} key={source._id}>
            <article className="import-source"><div className="import-source-main"><div className="import-source-meta"><span>{programLabel(source.type)} · FY{source.fiscalYear}</span><span className={`import-status ${needsAttention(source) ? 'error' : source.status === 'done' ? 'success' : 'neutral'}`}>{sourceStatus(source)}</span></div><a href={source.url} target="_blank" rel="noreferrer" className="import-filename">{source.filename} <FiExternalLink aria-label="Opens DOL workbook" /></a>
                <p className="admin-help">{source.status === 'validating' ? `${formatCount(source.validationProgress?.rows ?? 0)} rows checked` : `${formatCount(source.progress?.processed ?? source.validation?.rows)} ${source.progress?.processed != null ? 'cases processed' : 'source rows'}`} · {formatImportDate(source.checkedAt || source.startedAt)}</p>
                {source.error && <p className="import-source-error">{source.error}</p>}
            </div><div className="import-source-action">{source.validation ? <button className="btn btn-secondary" id={`report-toggle-${source._id}`} aria-expanded={openReport === source._id} aria-controls={`validation-${source._id}`} onClick={() => setOpenReport(openReport === source._id ? null : source._id)}><FiChevronDown />{openReport === source._id ? 'Hide report' : 'View validation report'}</button> : <span className="admin-help">Report not available yet</span>}</div></article>
            {openReport === source._id && <ReportLoader key={`${source._id}:${source.startedAt}`} source={source} onClose={() => closeReport(source._id)} />}
        </div>)}</div> : status && <div className="admin-empty"><h4>{sources.length ? 'No files match these filters' : 'No import history yet'}</h4><p>{sources.length ? 'Try another program, status, or filename.' : 'Scheduled imports will appear here with their validation results.'}</p>{sources.length > 0 && <button className="admin-text-button" onClick={() => { setProgram('all'); setState('all'); setQuery(''); setPage(0); }}>Clear filters</button>}</div>}
        {filtered.length > 0 && <div className="import-pagination"><span>{currentPage * 10 + 1}–{Math.min((currentPage + 1) * 10, filtered.length)} of {filtered.length} files</span><div className="admin-actions"><button className="btn btn-secondary" disabled={currentPage === 0} onClick={() => { setPage(currentPage - 1); setOpenReport(null); }}>Previous</button><button className="btn btn-secondary" disabled={(currentPage + 1) * 10 >= filtered.length} onClick={() => { setPage(currentPage + 1); setOpenReport(null); }}>Next</button></div></div>}
        </section>
        </div>
        <details className="import-operations"><summary>Import schedule & source availability</summary>
        <div className="import-schedule"><div><span className="section-kicker">Release checks · PWD, PERM & H-1B</span><p>Sundays at 3:00 AM Pacific</p></div><div><span className="section-kicker">Historical backfill · PWD, PERM & H-1B</span><p>Hourly at :15, two pending files at a time</p></div><p className="admin-help">Historical files backfill from FY2008. Completed files are skipped; sources needing review stay visible in file history.</p></div>
        {coverage?.unavailable?.length > 0 && <details className="coverage-gaps"><summary>Unavailable DOL archives · {coverage.unavailable.length}</summary><p className="admin-help">DOL has no archive file for these program years. They are separate from failed imports.</p><p>{coverage.unavailable.map(item => `${programLabel(item.type)} FY${item.fiscalYear}`).join(' · ')}</p></details>}
        </details>
    </section>;
}
