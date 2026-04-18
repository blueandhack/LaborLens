import React, { useState, useEffect } from 'react';
import axios from 'axios';
import { Link, useSearchParams } from 'react-router-dom';
import { FiSearch, FiMapPin } from 'react-icons/fi';

const getStatusClass = (status) => {
    if (!status) return 'other';
    const s = status.toLowerCase();
    if (s.includes('certified') && !s.includes('denied')) return 'certified';
    if (s.includes('denied')) return 'denied';
    if (s.includes('withdrawn')) return 'withdrawn';
    return 'other';
};

const formatStatus = (status) => {
    if (!status) return 'Unknown';
    const s = status.toLowerCase();
    if (s.includes('certified') && !s.includes('denied')) return 'Certified';
    if (s.includes('denied')) return 'Denied';
    if (s.includes('withdrawn')) return 'Withdrawn';
    return status.length > 18 ? status.slice(0, 18) + '…' : status;
};

const formatWage = (from, to, per) => {
    if (!from) return 'N/A';
    const lo = parseFloat(from);
    if (isNaN(lo)) return 'N/A';
    const unit = per || 'yr';
    if (to && parseFloat(to) !== lo) {
        const hi = parseFloat(to);
        return `$${lo.toLocaleString()} – $${hi.toLocaleString()} / ${unit}`;
    }
    return `$${lo.toLocaleString()} / ${unit}`;
};

const PermSearchView = () => {
    const [searchParams, setSearchParams] = useSearchParams();

    const initialCompany      = searchParams.get('company') || '';
    const initialLocation     = searchParams.get('location') || '';
    const initialCaseNumber   = searchParams.get('caseNumber') || '';
    const initialJobTitle     = searchParams.get('jobTitle') || '';
    const initialDecisionYear = searchParams.get('decisionYear') || '';
    const initialReceivedYear = searchParams.get('receivedYear') || '';
    const initialPage         = parseInt(searchParams.get('page')) || 1;
    const initialLimit        = parseInt(searchParams.get('limit')) || 12;

    const [company, setCompany]           = useState(initialCompany);
    const [location, setLocation]         = useState(initialLocation);
    const [caseNumber, setCaseNumber]     = useState(initialCaseNumber);
    const [jobTitle, setJobTitle]         = useState(initialJobTitle);
    const [decisionYear, setDecisionYear] = useState(initialDecisionYear);
    const [receivedYear, setReceivedYear] = useState(initialReceivedYear);
    const [limit, setLimit]               = useState(initialLimit);

    const [results, setResults]               = useState([]);
    const [availableYears, setAvailableYears] = useState([]);
    const [isLoading, setIsLoading]           = useState(false);
    const [currentPage, setCurrentPage]       = useState(initialPage);
    const [totalPages, setTotalPages]         = useState(1);
    const [totalCount, setTotalCount]         = useState(0);

    const fetchResults = async (page = 1, currentLimit = limit) => {
        setIsLoading(true);
        try {
            const { data } = await axios.get('/api/search/perm', {
                params: { company, location, caseNumber, jobTitle, decisionYear, receivedYear, page, limit: currentLimit }
            });
            setResults(data.cases);
            setTotalPages(data.totalPages);
            setCurrentPage(data.currentPage);
            setTotalCount(data.totalCount);
        } catch (error) {
            console.error('Error fetching PERM results:', error);
        } finally {
            setIsLoading(false);
        }
    };

    const fetchYears = async () => {
        try {
            const { data } = await axios.get('/api/search/perm/years');
            setAvailableYears(data || []);
        } catch (error) {
            console.error('Error fetching available PERM years:', error);
        }
    };

    const updateURL = (c, l, cn, jt, dy, ry, page, lim) => {
        const params = new URLSearchParams();
        if (c)    params.set('company', c);
        if (l)    params.set('location', l);
        if (cn)   params.set('caseNumber', cn);
        if (jt)   params.set('jobTitle', jt);
        if (dy)   params.set('decisionYear', dy);
        if (ry)   params.set('receivedYear', ry);
        if (page > 1)   params.set('page', page);
        if (lim !== 12) params.set('limit', lim);
        setSearchParams(params, { replace: true });
    };

    useEffect(() => {
        fetchYears();
        fetchResults(currentPage, limit);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    const handleSearchClick = () => {
        updateURL(company, location, caseNumber, jobTitle, decisionYear, receivedYear, 1, limit);
        fetchResults(1, limit);
    };

    const handleClearClick = () => {
        setCompany(''); setLocation(''); setCaseNumber(''); setJobTitle('');
        setDecisionYear(''); setReceivedYear(''); setLimit(12);
        updateURL('', '', '', '', '', '', 1, 12);
        setIsLoading(true);
        axios.get('/api/search/perm', { params: { page: 1, limit: 12 } })
            .then(({ data }) => {
                setResults(data.cases);
                setTotalPages(data.totalPages);
                setCurrentPage(data.currentPage);
                setTotalCount(data.totalCount);
            })
            .catch(err => console.error(err))
            .finally(() => setIsLoading(false));
    };

    const handlePageChange = (newPage) => {
        if (newPage >= 1 && newPage <= totalPages) {
            updateURL(company, location, caseNumber, jobTitle, decisionYear, receivedYear, newPage, limit);
            fetchResults(newPage, limit);
        }
    };

    const onKey = (e) => e.key === 'Enter' && handleSearchClick();

    return (
        <div>
            {/* Search panel */}
            <div className="search-bar-container glass-panel" style={{ padding: '18px 20px', flexDirection: 'column', gap: '12px' }}>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 1fr))', gap: '10px', width: '100%' }}>
                    <input className="search-input" type="text" placeholder="Company Name"
                        value={company} onChange={e => setCompany(e.target.value)} onKeyDown={onKey} />
                    <input className="search-input" type="text" placeholder="City or State"
                        value={location} onChange={e => setLocation(e.target.value)} onKeyDown={onKey} />
                    <input className="search-input" type="text" placeholder="Case Number"
                        value={caseNumber} onChange={e => setCaseNumber(e.target.value)} onKeyDown={onKey} />
                    <input className="search-input" type="text" placeholder="Job Title"
                        value={jobTitle} onChange={e => setJobTitle(e.target.value)} onKeyDown={onKey} />
                    <select className="search-input" value={decisionYear} onChange={e => setDecisionYear(e.target.value)}>
                        <option value="">Decision Year</option>
                        {availableYears.map(y => <option key={`dec-${y}`} value={y}>{y}</option>)}
                    </select>
                    <select className="search-input" value={receivedYear} onChange={e => setReceivedYear(e.target.value)}>
                        <option value="">Received Year</option>
                        {availableYears.map(y => <option key={`rec-${y}`} value={y}>{y}</option>)}
                    </select>
                </div>
                <div style={{ display: 'flex', gap: '8px', alignSelf: 'flex-end' }}>
                    <button className="btn btn-secondary" style={{ padding: '8px 18px' }} onClick={handleClearClick} disabled={isLoading}>
                        Clear
                    </button>
                    <button className="btn" style={{ padding: '8px 24px' }} onClick={handleSearchClick} disabled={isLoading}>
                        {isLoading
                            ? <><span style={{ width: 14, height: 14, border: '2px solid rgba(255,255,255,.3)', borderRadius: '50%', borderTopColor: '#fff', animation: 'spin 0.75s linear infinite', display: 'inline-block' }} /> Searching…</>
                            : <><FiSearch size={14} /> Search</>
                        }
                    </button>
                </div>
            </div>

            {/* Results info */}
            <div className="results-info-bar">
                <span>{totalCount.toLocaleString()} records found</span>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                    <span>Per page:</span>
                    <select className="search-input" value={limit} disabled={isLoading}
                        onChange={e => { const v = parseInt(e.target.value); setLimit(v); updateURL(company, location, caseNumber, jobTitle, decisionYear, receivedYear, 1, v); fetchResults(1, v); }}
                        style={{ padding: '5px 28px 5px 10px', width: 'auto' }}>
                        <option value={12}>12</option>
                        <option value={24}>24</option>
                        <option value={48}>48</option>
                        <option value={96}>96</option>
                    </select>
                </div>
            </div>

            {/* Results */}
            {isLoading ? (
                <div className="glass-panel loading-overlay">
                    <div className="spinner-large" />
                    <h3>Searching PERM Records</h3>
                    <p>Scanning the database…</p>
                </div>
            ) : (
                <div className="results-grid">
                    {results.map(c => {
                        const statusClass = getStatusClass(c.CASE_STATUS);
                        const loc = [c.EMP_CITY, c.EMP_STATE].filter(Boolean).join(', ') || 'N/A';
                        return (
                            <Link key={c._id} to={`/cases/${c._id}`} style={{ textDecoration: 'none', color: 'inherit' }}>
                                <div className={`case-card glass-panel status-${statusClass}`}>
                                    <div className="card-header">
                                        <span className="company-name">
                                            {c.EMP_BUSINESS_NAME || 'Unknown Company'}
                                        </span>
                                        <span className={`status-badge status-badge-${statusClass}`}>
                                            {formatStatus(c.CASE_STATUS)}
                                        </span>
                                    </div>

                                    <div className="card-job-title">{c.JOB_TITLE || '—'}</div>

                                    <div className="card-divider" />

                                    <div className="card-location">
                                        <FiMapPin size={11} />
                                        {loc}
                                        {c.VISA_CLASS && <span style={{ marginLeft: 'auto', fontFamily: 'JetBrains Mono, monospace', fontSize: 11 }}>{c.VISA_CLASS}</span>}
                                    </div>

                                    <div className="card-body">
                                        <div className="info-row">
                                            <span className="info-label">Wage</span>
                                            <span className="info-value">{formatWage(c.JOB_OPP_WAGE_FROM, c.JOB_OPP_WAGE_TO, c.JOB_OPP_WAGE_PER)}</span>
                                        </div>
                                        {c.PWD_OES_WAGE_LEVEL && (
                                            <div className="info-row">
                                                <span className="info-label">OES Level</span>
                                                <span className="info-value">{c.PWD_OES_WAGE_LEVEL}</span>
                                            </div>
                                        )}
                                        <div className="info-row">
                                            <span className="info-label">PWD Number</span>
                                            <span className="info-value mono">{c.JOB_OPP_PWD_NUMBER || 'N/A'}</span>
                                        </div>
                                        <div className="info-row">
                                            <span className="info-label">Decision Date</span>
                                            <span className="info-value">
                                                {c.DECISION_DATE ? new Date(c.DECISION_DATE).toLocaleDateString() : 'N/A'}
                                            </span>
                                        </div>
                                        {c.PWD_DETERMINATION_DATE && (
                                            <div className="info-row">
                                                <span className="info-label">PWD Det. Date</span>
                                                <span className="info-value">
                                                    {new Date(c.PWD_DETERMINATION_DATE).toLocaleDateString()}
                                                </span>
                                            </div>
                                        )}
                                    </div>

                                    <div className="card-footer">
                                        <span className="case-number">{c.CASE_NUMBER}</span>
                                    </div>
                                </div>
                            </Link>
                        );
                    })}
                </div>
            )}

            {totalPages > 1 && (
                <div className="pagination">
                    <button className="btn btn-secondary" onClick={() => handlePageChange(currentPage - 1)} disabled={currentPage === 1}>
                        ← Prev
                    </button>
                    <span className="page-info">Page {currentPage} of {totalPages}</span>
                    <button className="btn btn-secondary" onClick={() => handlePageChange(currentPage + 1)} disabled={currentPage === totalPages}>
                        Next →
                    </button>
                </div>
            )}
        </div>
    );
};

export default PermSearchView;
