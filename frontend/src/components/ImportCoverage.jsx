import { useState } from 'react';
import { FiActivity, FiArrowUpRight, FiCheck, FiClock, FiChevronDown, FiExternalLink, FiX } from 'react-icons/fi';
import ReportLoader from './ValidationReportLoader';
import { formatCount, formatImportDate, programLabel, sourceStatus } from '../utils/importPresentation';
import './ImportCoverage.css';

const CELL_LABEL = { imported: 'Imported', covered: 'Covered', active: 'In progress', pending: 'Queued', partial: 'Partial', attention: 'Review', unavailable: 'Not listed', unknown: 'Unknown' };
const PROGRAM_LABEL = { active: 'Running', complete: 'Up to date', attention: 'Needs attention', waiting: 'Waiting' };
const quarterLabel = file => file.period === 'annual' ? 'Annual release' : `Q${file.quarter}`;
const viaLabel = cell => cell.viaAnnual ? 'annual file' : `Q${cell.viaQuarter}`;
const CellIcon = ({ state }) => state === 'imported' ? <FiCheck /> : state === 'covered' ? <FiArrowUpRight /> : state === 'active' ? <FiActivity /> : null;

function CurrentFile({ file, onSelect }) {
    const label = file.stage === 'importing' ? 'Importing cases' : file.stage === 'validating' ? 'Validating workbook' : 'Downloading workbook';
    return <div className="coverage-current-file">
        <div className="coverage-current-heading"><span><FiActivity aria-hidden="true" /> {label}</span><strong>FY{file.fiscalYear} · {quarterLabel(file)}</strong></div>
        <div className="coverage-file-name">{file.filename}</div>
        <div className={`coverage-meter current ${file.percentage == null ? 'indeterminate' : ''}`} role="progressbar" aria-label={`${label}: ${file.filename}`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={file.percentage ?? undefined} aria-valuetext={file.percentage == null ? file.stage === 'validating' ? `${formatCount(file.processed)} source rows checked; total not yet known` : 'Download in progress' : `${formatCount(file.processed)} of ${formatCount(file.total)} cases processed`}>
            <span style={{ width: file.percentage == null ? '30%' : `${file.percentage}%` }} />
        </div>
        <div className="coverage-current-numbers">
            <span>{file.stage === 'importing' ? <>{formatCount(file.processed)} / {formatCount(file.total)} cases</> : file.stage === 'validating' ? <>{formatCount(file.processed)} rows checked · total pending</> : 'Row counts appear after validation'}</span>
            {file.percentage != null && <strong>{file.percentage}%</strong>}
        </div>
        {file.stage === 'importing' && <p className="admin-help">{formatCount(file.inserted)} inserted · {formatCount(file.updated)} updated{file.protected > 0 ? ` · ${formatCount(file.protected)} newer records protected` : ''}</p>}
        <button className="admin-text-button" onClick={onSelect}>Inspect this release</button>
    </div>;
}

export default function ImportCoverage({ progress, sources }) {
    const [view, setView] = useState('h1b');
    const [selection, setSelection] = useState(null);
    const [openReport, setOpenReport] = useState(null);
    const [year, setYear] = useState('all');
    const programs = progress.programs;
    const shown = programs.filter(program => view === 'all' || program.type === view);
    const allYears = [...new Set(programs.flatMap(program => program.years.map(row => row.fiscalYear)))].sort((a, b) => b - a);
    const years = year === 'all' ? allYears : allYears.filter(value => value === Number(year));
    const selectedProgram = programs.find(program => program.type === selection?.type);
    const cell = selectedProgram?.years.find(row => row.fiscalYear === selection.year)?.quarters.find(item => item.quarter === selection.quarter);
    const selectedFiles = cell ? selectedProgram.files.filter(file => cell.fileUrls.includes(file.url)) : [];
    const directFiles = cell ? selectedProgram.files.filter(file => cell.directUrls.includes(file.url) && !cell.fileUrls.includes(file.url)) : [];
    const select = (type, fiscalYear, quarter) => {
        setSelection({ type, year: fiscalYear, quarter });
        setOpenReport(null);
        requestAnimationFrame(() => document.getElementById('coverage-detail-heading')?.focus({ preventScroll: false }));
    };
    const close = () => {
        const previous = selection;
        setSelection(null); setOpenReport(null);
        document.getElementById(`coverage-${previous.type}-${previous.year}-${previous.quarter}`)?.focus({ preventScroll: true });
    };
    const renderFile = file => {
        const source = sources.find(item => item._id === file.sourceId);
        return <div className="coverage-evidence-file" key={file.url}>
            <div className="coverage-evidence-heading"><a href={file.url} target="_blank" rel="noreferrer">{file.filename} <FiExternalLink aria-label="Opens DOL workbook" /></a><span>{file.status === 'revalidation' ? 'Needs revalidation' : !file.required && file.status === 'pending' ? 'Separate snapshot not required' : sourceStatus(file)}</span></div>
            {file.progress?.processed != null && <p className="admin-help">{formatCount(file.progress.processed)} cases processed{file.completedAt ? ` · completed ${formatImportDate(file.completedAt)}` : ''}</p>}
            {file.error && <p className="import-source-error">{file.error}</p>}
            {source && file.canViewReport && <button className="admin-text-button" id={`coverage-report-toggle-${file.sourceId}`} aria-controls={`coverage-validation-${file.sourceId}`} aria-expanded={openReport === file.sourceId} onClick={() => setOpenReport(openReport === file.sourceId ? null : file.sourceId)}><FiChevronDown /> {openReport === file.sourceId ? 'Hide validation details' : 'View validation details'}</button>}
            {openReport === file.sourceId && source && <ReportLoader source={source} reportId={`coverage-validation-${file.sourceId}`} onClose={() => { setOpenReport(null); document.getElementById(`coverage-report-toggle-${file.sourceId}`)?.focus(); }} />}
        </div>;
    };

    return <section className="coverage-dashboard" aria-labelledby="coverage-heading">
        <div className="admin-section-heading"><div><p className="section-kicker">Live import monitor</p><h3 id="coverage-heading">Progress by program</h3></div><p className="coverage-updated"><span>Updates every 15 seconds</span><span>Updated <time dateTime={progress.asOf} title={formatImportDate(progress.asOf)}>{new Date(progress.asOf).toLocaleTimeString()}</time></span></p></div>
        <div className="coverage-programs">
            {programs.map(program => <article className={`coverage-program ${program.state} ${view === program.type ? 'selected' : ''}`} key={program.type}>
                <div className="coverage-program-heading"><h4><button aria-pressed={view === program.type} onClick={() => { setView(program.type); setSelection(null); setOpenReport(null); }}>{programLabel(program.type)}</button></h4><span className={`import-status ${program.state === 'active' ? 'neutral' : program.state === 'attention' ? 'error' : program.state === 'complete' ? 'success' : ''}`}>{PROGRAM_LABEL[program.state]}</span></div>
                <p className="coverage-program-total"><strong>{formatCount(program.completedFiles)}</strong><span> / {formatCount(program.totalFiles)} releases imported</span></p>
                <div className="coverage-meter" role="progressbar" aria-label={`${programLabel(program.type)} required release files imported`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={program.percentage ?? undefined} aria-valuetext={program.inventoryKnown ? `${program.completedFiles} of ${program.totalFiles} required release files imported` : 'Archive inventory has not loaded'}><span style={{ width: `${program.percentage ?? 0}%` }} /></div>
                <p className="coverage-program-caption">{program.inventoryKnown ? `${program.percentage}% of required releases · ${program.pendingFiles} queued${program.attentionFiles ? ` · ${program.attentionFiles} need attention` : ''}` : 'Waiting for archive inventory'}</p>
                {program.current.map(file => <CurrentFile key={file.url} file={file} onSelect={() => { setView(program.type); setYear('all'); select(program.type, file.fiscalYear, file.quarter); }} />)}
                {!program.current.length && <p className="coverage-idle"><FiClock aria-hidden="true" />{program.state === 'complete' ? 'Latest listed releases are imported.' : program.state === 'attention' ? 'Review the highlighted releases below.' : program.pendingFiles > 0 && programs.some(item => item.current.length > 0) ? 'Queued while another program imports.' : 'No file is processing for this program.'}</p>}
            </article>)}
        </div>
        <div className="coverage-grid-heading"><div><h3>Year & quarter coverage</h3><p className="admin-help">Each cell opens the release status and validation details.</p></div><div className="coverage-grid-controls"><label><span id="coverage-view-label">Program</span><select aria-labelledby="coverage-view-label" value={view} onChange={event => { setView(event.target.value); setSelection(null); setOpenReport(null); }}>{programs.map(program => <option value={program.type} key={program.type}>{programLabel(program.type)}</option>)}<option value="all">All programs</option></select></label><label><span id="coverage-year-label">Fiscal year</span><select aria-labelledby="coverage-year-label" value={year} onChange={event => { setYear(event.target.value); setSelection(null); setOpenReport(null); }}><option value="all">All years</option>{allYears.map(value => <option value={value} key={value}>{value}</option>)}</select></label></div></div>
        <p className="coverage-explainer"><strong>Imported</strong> means the quarter’s file was imported directly. <strong>Covered</strong> means a later cumulative or annual release includes that quarter. Earlier snapshot files do not need a separate import.</p>
        <div className="coverage-legend" aria-label="Coverage legend">{['imported', 'covered', 'active', 'pending', 'partial', 'attention', 'unavailable', 'unknown'].map(state => <span key={state}><i className={`coverage-key ${state}`} aria-hidden="true" />{CELL_LABEL[state]}</span>)}</div>
        {!progress.publishedQuarterInventory && <p className="admin-help">Showing known import targets. Separate quarterly snapshot availability will appear after the next archive inventory refresh.</p>}
        {selection && cell && <section className="coverage-detail" aria-labelledby="coverage-detail-heading">
            <div className="admin-section-heading"><div><p className="section-kicker">Release details</p><h4 id="coverage-detail-heading" tabIndex={-1}>{programLabel(selection.type)} · FY{selection.year} Q{selection.quarter}</h4></div><button className="admin-text-button" onClick={close}><FiX /> Close details</button></div>
            <p className={`coverage-detail-status ${cell.state}`}><CellIcon state={cell.state} />{cell.state === 'covered' ? `Covered by the imported FY${selection.year} ${cell.viaAnnual ? 'annual release' : `Q${cell.viaQuarter} cumulative release`}. This quarter’s snapshot was not separately imported.` : cell.state === 'unknown' ? 'Archive inventory has not loaded for this program. Coverage is not yet known.' : cell.state === 'unavailable' ? 'No separate release is listed for this quarter, and no imported later release covers it.' : cell.state === 'imported' ? 'The file or files for this quarter were imported and validated.' : `${cell.label}${cell.viaQuarter && (cell.viaQuarter > selection.quarter || cell.viaAnnual) ? ` · awaiting the ${viaLabel(cell)} covering this quarter` : ''}.`}</p>
            {cell.state === 'unavailable' && <p className="admin-help">“Not listed” reflects the current DOL archive inventory. It is separate from an import failure or an item waiting in the queue.</p>}
            {selectedFiles.map(renderFile)}
            {directFiles.length > 0 && <details className="coverage-snapshots"><summary>Separate quarterly snapshots ({directFiles.length})</summary><p className="admin-help">These older snapshots are available at DOL. The importer uses the latest cumulative release for the year.</p>{directFiles.map(renderFile)}</details>}
        </section>}
        {!allYears.length && <p className="admin-help">Coverage appears after the first DOL archive discovery.</p>}
        <div className={`coverage-table-scroll ${shown.length > 1 ? 'compare-programs' : ''}`} tabIndex={0} aria-label="Scrollable fiscal-year and quarter import coverage">
            <table className="coverage-table"><caption className="sr-only">{shown.map(program => programLabel(program.type)).join(', ')} fiscal-year and quarter import coverage. Choose a cell to inspect its source files.</caption><thead><tr><th rowSpan={2} scope="col">Fiscal<br />year</th>{shown.map(program => <th colSpan={4} scope="colgroup" key={program.type}>{programLabel(program.type)}</th>)}</tr><tr>{shown.flatMap(program => [1, 2, 3, 4].map(q => <th scope="col" key={`${program.type}-${q}`}>Q{q}</th>))}</tr></thead><tbody>{years.map(fiscalYear => <tr key={fiscalYear}><th scope="row">{fiscalYear}</th>{shown.flatMap(program => {
                const row = program.years.find(item => item.fiscalYear === fiscalYear);
                return (row?.quarters || []).map(item => <td key={`${program.type}-${item.quarter}`}><button id={`coverage-${program.type}-${fiscalYear}-${item.quarter}`} className={`coverage-cell ${item.state} ${selection?.type === program.type && selection?.year === fiscalYear && selection?.quarter === item.quarter ? 'is-selected' : ''}`} aria-label={`${programLabel(program.type)} FY${fiscalYear} Q${item.quarter}: ${item.label}${item.viaQuarter ? ` via ${viaLabel(item)}` : ''}`} aria-pressed={selection?.type === program.type && selection?.year === fiscalYear && selection?.quarter === item.quarter} onClick={() => select(program.type, fiscalYear, item.quarter)}><span><CellIcon state={item.state} />{CELL_LABEL[item.state]}</span>{item.viaQuarter && item.state !== 'imported' && item.state !== 'unavailable' && <small>{item.viaAnnual ? 'Annual' : item.viaQuarter > item.quarter ? `via Q${item.viaQuarter}` : `Q${item.viaQuarter} release`}</small>}</button></td>);
            })}</tr>)}</tbody></table>
        </div>
        <p className="admin-help coverage-table-note">Fiscal years follow DOL disclosure releases. Required-release counts use the latest cumulative release per year, including all independent files or form variants. “Covered” describes data coverage; it does not count as a separately imported quarterly file.</p>
        <p className="admin-help">DOL archive inventory checked {formatImportDate(progress.inventoryCheckedAt)}.</p>
    </section>;
}
