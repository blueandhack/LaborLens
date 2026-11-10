import { useCallback, useEffect, useState } from 'react';
import { FiActivity, FiAlertTriangle, FiCheckCircle, FiCloud, FiCpu, FiDatabase, FiHardDrive, FiRefreshCw, FiServer, FiShield, FiUser, FiXCircle } from 'react-icons/fi';
import {
  REPOSITORY, formatBytes, formatCount, formatCompact, formatDuration, timeAgo, formatDate, formatDateTime, share, healthChecks, overallLevel, describeActivity,
} from '../utils/adminOverview';
import './AdminOverview.css';

const REFRESH_MS = 30000;
const LEVEL_ICON = { ok: FiCheckCircle, warning: FiAlertTriangle, error: FiXCircle };
const LEVEL_TEXT = { ok: 'All systems normal', warning: 'Needs attention', error: 'Action needed' };

function Meter({ label, used, max, detail }) {
  const value = share(used, max);
  const level = value > 0.9 ? 'error' : value > 0.75 ? 'warning' : 'ok';
  return (
    <div className="ov-meter">
      <div className="ov-meter-head"><span>{label}</span><strong>{max ? `${Math.round(value * 100)}%` : '—'}</strong></div>
      <div className="ov-meter-track" role="meter" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(value * 100)}>
        <span className={'is-' + level} style={{ width: `${value * 100}%` }} />
      </div>
      <small>{detail}</small>
    </div>
  );
}

// Filings per year as small bars; hovering or focusing a bar names its value.
function YearBars({ years, label }) {
  const [active, setActive] = useState(null);
  if (!years?.length) return <p className="ov-muted">Yearly totals appear after the next map refresh.</p>;
  const max = Math.max(...years.map(year => year.total));
  const width = 100 / years.length;
  const shown = active ?? years.at(-1);
  return (
    <figure className="ov-bars">
      <figcaption><span>{active ? `${active.year}` : 'Latest year'}</span><strong>{formatCount(shown.total)}</strong></figcaption>
      <svg viewBox="0 0 100 40" preserveAspectRatio="none" role="img" aria-label={`${label} filings per year, ${years[0].year} to ${years.at(-1).year}. Highest: ${formatCount(max)}.`}
        onPointerLeave={() => setActive(null)}>
        {years.map((year, index) => {
          const height = max ? Math.max(0.6, year.total / max * 38) : 0;
          return <g key={year.year} onPointerEnter={() => setActive(year)}>
            <rect className="ov-bar-hit" x={index * width} y="0" width={width} height="40" />
            <rect className={active?.year === year.year ? 'ov-bar is-active' : 'ov-bar'} x={index * width + width * 0.12} y={40 - height} width={width * 0.76} height={height} rx="0.6" />
          </g>;
        })}
      </svg>
      <div className="ov-bars-axis"><span>{years[0].year}</span><span>{years.at(-1).year}</span></div>
    </figure>
  );
}

function Tile({ icon, label, value, detail, tone }) {
  const Icon = icon;
  return (
    <div className={`ov-tile${tone ? ' is-' + tone : ''}`}>
      <span className="ov-tile-label"><Icon aria-hidden="true" />{label}</span>
      <strong className="ov-tile-value">{value}</strong>
      <span className="ov-tile-detail">{detail}</span>
    </div>
  );
}

function DatasetCard({ dataset, now }) {
  const release = dataset.latestRelease;
  return (
    <article className="ov-dataset">
      <header><h4>{dataset.label}</h4><span className="ov-chip">{formatCompact(dataset.records)} records</span></header>
      <YearBars years={dataset.years} label={dataset.label} />
      <dl className="ov-facts">
        <div><dt>Newest case</dt><dd>{formatDate(dataset.newestCase)}</dd></div>
        <div><dt>Latest release</dt><dd>{release ? `FY${release.fiscalYear} Q${release.quarter}` : '—'}</dd></div>
        <div><dt>Last imported</dt><dd title={formatDateTime(dataset.lastImportedAt)}>{timeAgo(dataset.lastImportedAt, now)}</dd></div>
        <div><dt>Last checked</dt><dd title={formatDateTime(dataset.lastCheckedAt)}>{timeAgo(dataset.lastCheckedAt, now)}</dd></div>
      </dl>
    </article>
  );
}

function Activity({ items, now }) {
  if (!items.length) return <p className="ov-muted">No activity recorded yet.</p>;
  return (
    <ol className="ov-timeline">
      {items.map((item, index) => {
        const { tone, title, detail } = describeActivity(item);
        const Icon = item.kind === 'import' ? FiDatabase : item.kind === 'refresh' ? FiRefreshCw : /sign-in|password|username/.test(item.type) ? FiUser : FiShield;
        return <li key={index} className={'is-' + tone}>
          <span className="ov-timeline-icon" aria-hidden="true"><Icon /></span>
          <div><strong>{title}</strong>{detail && <span>{detail}</span>}
            {item.kind === 'admin' && (item.ip || item.userAgent) && <small>{[item.ip, browserOf(item.userAgent)].filter(Boolean).join(' · ')}</small>}</div>
          <time dateTime={new Date(item.at).toISOString()} title={formatDateTime(item.at)}>{timeAgo(item.at, now)}</time>
        </li>;
      })}
    </ol>
  );
}

// A short browser and system name from a user-agent string.
function browserOf(agent) {
  if (!agent) return '';
  const browser = /Edg\//.test(agent) ? 'Edge' : /Firefox\//.test(agent) ? 'Firefox' : /Chrome\//.test(agent) ? 'Chrome' : /Safari\//.test(agent) ? 'Safari' : /curl|node|python/i.test(agent) ? 'Script' : 'Browser';
  const system = /iPhone|iPad/.test(agent) ? 'iOS' : /Android/.test(agent) ? 'Android' : /Mac OS X/.test(agent) ? 'macOS' : /Windows/.test(agent) ? 'Windows' : /Linux/.test(agent) ? 'Linux' : '';
  return [browser, system].filter(Boolean).join(' on ');
}

export default function AdminOverview({ onNavigate }) {
  const [state, setState] = useState({ data: null, error: '', loading: true });
  const [now, setNow] = useState(() => Date.now());
  const load = useCallback(async () => {
    setState(current => ({ ...current, loading: true }));
    try {
      const res = await fetch('/api/admin/overview', { headers: { Authorization: `Bearer ${localStorage.getItem('adminToken')}` } });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'The overview could not load.');
      setState({ data, error: '', loading: false });
    } catch (error) {
      setState(current => ({ ...current, error: error.message, loading: false }));
    }
    setNow(Date.now());
  }, []);
  useEffect(() => {
    load();
    const refresh = setInterval(load, REFRESH_MS), tick = setInterval(() => setNow(Date.now()), 5000);
    return () => { clearInterval(refresh); clearInterval(tick); };
  }, [load]);

  const { data, error, loading } = state;
  if (!data) return <section className="ov" aria-busy={loading}>
    {error ? <p className="import-notice error" role="alert">{error}</p> : <div className="ov-skeleton" role="status">Loading the overview…</div>}
  </section>;

  const checks = healthChecks(data, now);
  const level = overallLevel(checks);
  const LevelIcon = LEVEL_ICON[level];
  const totalRecords = data.datasets.reduce((sum, item) => sum + item.records, 0) + (data.uscis?.records || 0);
  const newest = data.datasets.map(item => item.newestCase).filter(Boolean).sort().at(-1);
  const backup = data.jobs.backup;
  const imports = data.jobs.imports;
  const db = data.database, server = data.server;
  const biggest = data.collections.slice(0, 8);
  const largest = Math.max(1, ...biggest.map(row => row.storageSize + row.indexSize));

  return (
    <section className="ov" aria-labelledby="ov-heading" aria-busy={loading}>
      <div className={`ov-hero is-${level}`}>
        <div className="ov-hero-status">
          <LevelIcon aria-hidden="true" />
          <div><p className="section-kicker">System status</p><h3 id="ov-heading">{LEVEL_TEXT[level]}</h3>
            <p>Updated {timeAgo(data.generatedAt, now)} · refreshes every 30 seconds{data.viewer ? ` · signed in as ${data.viewer}` : ''}</p></div>
          <button type="button" className="btn btn-secondary" onClick={load} disabled={loading}><FiRefreshCw className={loading ? 'is-refreshing' : ''} aria-hidden="true" />{loading ? 'Refreshing…' : 'Refresh'}</button>
        </div>
        <ul className="ov-checks">{checks.map(check => {
          const Icon = LEVEL_ICON[check.level];
          return <li key={check.id} className={'is-' + check.level}><Icon aria-hidden="true" /><div><strong>{check.label}</strong><span>{check.detail}</span></div></li>;
        })}</ul>
        {error && <p className="import-notice error" role="alert">{error} Showing the last loaded data.</p>}
      </div>

      <div className="ov-tiles">
        <Tile icon={FiDatabase} label="Records" value={formatCompact(totalRecords)} detail={`${formatCount(totalRecords)} across DOL and USCIS data`} />
        <Tile icon={FiActivity} label="Newest case" value={formatDate(newest, { month: 'short', day: 'numeric', year: 'numeric' })} detail="Latest decision or determination" />
        <Tile icon={FiHardDrive} label="Database on disk" value={formatBytes(db.storageSize + db.indexSize)}
          detail={`${formatBytes(db.dataSize)} uncompressed · ${Math.round(db.dataSize / Math.max(1, db.storageSize))}× compression`} />
        <Tile icon={FiCloud} label="Last backup" tone={backup?.state === 'failed' ? 'error' : undefined}
          value={backup?.state === 'running' ? 'Running' : backup?.lastSuccess ? timeAgo(backup.lastSuccess.completedAt, now) : '—'}
          detail={backup?.lastSuccess ? `${formatBytes(backup.lastSuccess.archiveBytes)} encrypted in Google Drive` : 'Reported by the backup service'} />
        <Tile icon={FiRefreshCw} label="Automatic imports" tone={imports.latest?.error ? 'error' : undefined}
          value={imports.latest ? timeAgo(imports.latest.startedAt, now) : '—'} detail={imports.latest ? describeActivity({ kind: 'import', ...imports.latest }).detail : 'No runs yet'} />
        <Tile icon={FiShield} label="Failed sign-ins" tone={data.security.failedSignIns24h >= 10 ? 'warning' : undefined}
          value={formatCount(data.security.failedSignIns24h)} detail={`In the last 24 hours · ${data.security.blockedAddresses} blocked`} />
      </div>

      <div className="ov-section-head"><h3>Datasets</h3><button type="button" className="ov-link" onClick={() => onNavigate?.('data')}>Site data details</button></div>
      <div className="ov-datasets">
        {data.datasets.map(dataset => <DatasetCard key={dataset.program} dataset={dataset} now={now} />)}
        <article className="ov-dataset ov-dataset-small">
          <header><h4>USCIS</h4><span className="ov-chip">{formatCompact(data.uscis?.records)} rows</span></header>
          <dl className="ov-facts">
            <div><dt>H-1B employer approvals</dt><dd>{formatCount(data.uscis?.records)} rows</dd></div>
            <div><dt>I-140 statistics</dt><dd>{data.i140 ? `FY${data.i140.fiscalYear} Q${data.i140.quarter}` : '—'}</dd></div>
            <div><dt>I-140 imported</dt><dd>{timeAgo(data.i140?.importedAt, now)}</dd></div>
            <div><dt>Last USCIS upload</dt><dd>{data.jobs.uscis ? `${data.jobs.uscis.state}${data.jobs.uscis.finishedAt ? ', ' + timeAgo(data.jobs.uscis.finishedAt, now) : ''}` : '—'}</dd></div>
          </dl>
        </article>
      </div>

      <div className="ov-grid">
        <article className="ov-panel">
          <header><FiDatabase aria-hidden="true" /><h3>Database</h3><span className="ov-chip">MongoDB {db.version || ''}</span></header>
          {db.cache && <Meter label="Memory cache" used={db.cache.used} max={db.cache.max} detail={`${formatBytes(db.cache.used)} of ${formatBytes(db.cache.max)}`} />}
          <dl className="ov-facts">
            <div><dt>Up for</dt><dd>{formatDuration(db.uptimeSeconds)}</dd></div>
            <div><dt>Connections</dt><dd>{db.connections ? formatCount(db.connections.current) : '—'}</dd></div>
            <div><dt>Collections</dt><dd>{formatCount(db.collections)}</dd></div>
            <div><dt>Indexes</dt><dd>{formatBytes(db.indexSize)}</dd></div>
          </dl>
          <h4 className="ov-subhead">Largest collections <small>data and indexes on disk</small></h4>
          <ul className="ov-storage">{biggest.map(row => (
            <li key={row.name}>
              <span className="ov-storage-name" title={`${formatCount(row.records)} records`}>{row.name}</span>
              <span className="ov-storage-bar" aria-hidden="true">
                <i className="is-data" style={{ width: `${row.storageSize / largest * 100}%` }} />
                <i className="is-index" style={{ width: `${row.indexSize / largest * 100}%` }} />
              </span>
              <span className="ov-storage-size">{formatBytes(row.storageSize + row.indexSize)}</span>
            </li>
          ))}</ul>
          <p className="ov-legend"><i className="is-data" aria-hidden="true" />Data <i className="is-index" aria-hidden="true" />Indexes</p>
        </article>

        <article className="ov-panel">
          <header><FiServer aria-hidden="true" /><h3>Web server</h3>
            {server.version && <a className="ov-chip" href={`${REPOSITORY}/commit/${server.version}`} target="_blank" rel="noreferrer">{server.version.slice(0, 7)}</a>}</header>
          {server.container?.limit && <Meter label="Memory" used={server.container.used} max={server.container.limit} detail={`${formatBytes(server.container.used)} of ${formatBytes(server.container.limit)}`} />}
          <dl className="ov-facts">
            <div><dt>Up for</dt><dd title={formatDateTime(server.startedAt)}>{formatDuration(server.uptimeSeconds)}</dd></div>
            <div><dt>Node.js</dt><dd>{server.node}</dd></div>
            <div><dt>Heap in use</dt><dd>{formatBytes(server.memory.heapUsed)}</dd></div>
            <div><dt>Load (1/5/15 min)</dt><dd>{server.load.join(' / ')} <small>of {server.cpus} CPUs</small></dd></div>
          </dl>
          <p className="ov-muted ov-host"><FiCpu aria-hidden="true" /> {server.host}</p>

          <h4 className="ov-subhead">Background jobs</h4>
          <ul className="ov-jobs">
            <li><span>Refresh</span><strong className={data.jobs.refresh?.outcome === 'failed' ? 'is-error' : ''}>{data.jobs.refresh?.running ? `Running · ${data.jobs.refresh.step || ''}` : data.jobs.refresh?.outcome || '—'}</strong>
              <small>{data.jobs.refresh?.finishedAt ? `${timeAgo(data.jobs.refresh.finishedAt, now)} · ${formatDuration((new Date(data.jobs.refresh.finishedAt) - new Date(data.jobs.refresh.startedAt)) / 1000)}` : ''}</small></li>
            <li><span>Imports</span><strong>{imports.latest?.status || '—'}</strong><small>{imports.latest ? timeAgo(imports.latest.startedAt, now) : ''}</small></li>
            <li><span>Backup</span><strong className={backup?.state === 'failed' ? 'is-error' : ''}>{backup?.state || 'not reported'}</strong>
              <small>{backup?.lastSuccess ? `took ${formatDuration(backup.lastSuccess.durationSeconds)}` : ''}{backup?.nextRunAt ? ` · next ${formatDate(backup.nextRunAt, { month: 'short', day: 'numeric' })}` : ''}</small></li>
          </ul>
          {imports.recent.length > 0 && <div className="ov-runs" aria-label="Recent automatic import runs, newest first">
            {imports.recent.map(run => {
              const tone = describeActivity({ kind: 'import', ...run }).tone;
              return <span key={run.id} className={'is-' + tone} title={`${formatDateTime(run.startedAt)} · ${describeActivity({ kind: 'import', ...run }).detail}`} />;
            })}
          </div>}
        </article>
      </div>

      <div className="ov-grid ov-grid-wide">
        <article className="ov-panel">
          <header><FiActivity aria-hidden="true" /><h3>Recent activity</h3></header>
          <Activity items={data.activity} now={now} />
        </article>
        <article className="ov-panel">
          <header><FiShield aria-hidden="true" /><h3>Access</h3><button type="button" className="ov-link" onClick={() => onNavigate?.('security')}>Manage</button></header>
          <h4 className="ov-subhead">Administrators</h4>
          <ul className="ov-admins">{data.security.admins.map(admin => (
            <li key={admin.username}><span className="ov-avatar" aria-hidden="true">{admin.username.slice(0, 1).toUpperCase()}</span>
              <div><strong>{admin.username}{admin.username === data.viewer ? <em> (you)</em> : null}</strong>
                <small>Since {formatDate(admin.createdAt)} · changed {timeAgo(admin.updatedAt, now)}</small></div></li>
          ))}</ul>
          <dl className="ov-facts">
            <div><dt>Last sign-in</dt><dd>{data.security.lastSignIn ? `${data.security.lastSignIn.username}, ${timeAgo(data.security.lastSignIn.at, now)}` : '—'}</dd></div>
            <div><dt>From</dt><dd>{data.security.lastSignIn ? [data.security.lastSignIn.ip, browserOf(data.security.lastSignIn.userAgent)].filter(Boolean).join(' · ') || '—' : '—'}</dd></div>
            <div><dt>Failed sign-ins (24 h)</dt><dd>{formatCount(data.security.failedSignIns24h)}</dd></div>
            <div><dt>Blocked addresses</dt><dd>{formatCount(data.security.blockedAddresses)}</dd></div>
          </dl>
          <p className="ov-muted">Sign-in history is kept for 180 days. Passwords are never recorded.</p>
        </article>
      </div>
    </section>
  );
}
