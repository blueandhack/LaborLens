import React, { useState, useEffect } from 'react';
import axios from 'axios';
import { Link, useSearchParams } from 'react-router-dom';
import { FiSearch, FiBriefcase, FiMapPin, FiMap } from 'react-icons/fi';

const PermSearchView = () => {
    const [searchParams, setSearchParams] = useSearchParams();

    // Initialize state from URL if present
    const initialCompany = searchParams.get('company') || '';
    const initialLocation = searchParams.get('location') || '';
    const initialCaseNumber = searchParams.get('caseNumber') || '';
    const initialJobTitle = searchParams.get('jobTitle') || '';
    const initialDecisionYear = searchParams.get('decisionYear') || '';
    const initialReceivedYear = searchParams.get('receivedYear') || '';
    const initialPage = parseInt(searchParams.get('page')) || 1;
    const initialLimit = parseInt(searchParams.get('limit')) || 12;

    const [company, setCompany] = useState(initialCompany);
    const [location, setLocation] = useState(initialLocation);
    const [caseNumber, setCaseNumber] = useState(initialCaseNumber);
    const [jobTitle, setJobTitle] = useState(initialJobTitle);
    const [decisionYear, setDecisionYear] = useState(initialDecisionYear);
    const [receivedYear, setReceivedYear] = useState(initialReceivedYear);
    const [limit, setLimit] = useState(initialLimit);

    const [results, setResults] = useState([]);
    const [availableYears, setAvailableYears] = useState([]);
    const [isLoading, setIsLoading] = useState(false);
    const [currentPage, setCurrentPage] = useState(initialPage);
    const [totalPages, setTotalPages] = useState(1);
    const [totalCount, setTotalCount] = useState(0);

    const fetchResults = async (page = 1, currentLimit = limit) => {
        setIsLoading(true);
        try {
            const { data } = await axios.get(`/api/search/perm`, {
                params: {
                    company,
                    location,
                    caseNumber,
                    jobTitle,
                    decisionYear,
                    receivedYear,
                    page,
                    limit: currentLimit
                }
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
            const { data } = await axios.get(`/api/search/perm/years`);
            setAvailableYears(data || []);
        } catch (error) {
            console.error('Error fetching available PERM years:', error);
        }
    };

    // Update URL parameters when search or page changes
    const updateURL = (newCompany, newLocation, newCaseNumber, newJobTitle, newDecisionYear, newReceivedYear, newPage, newLimit) => {
        const params = new URLSearchParams();
        if (newCompany) params.set('company', newCompany);
        if (newLocation) params.set('location', newLocation);
        if (newCaseNumber) params.set('caseNumber', newCaseNumber);
        if (newJobTitle) params.set('jobTitle', newJobTitle);
        if (newDecisionYear) params.set('decisionYear', newDecisionYear);
        if (newReceivedYear) params.set('receivedYear', newReceivedYear);
        if (newPage > 1) params.set('page', newPage);
        if (newLimit !== 12) params.set('limit', newLimit);
        setSearchParams(params, { replace: true });
    };

    // Initial load and URL param response
    useEffect(() => {
        fetchYears();

        if (company || location || caseNumber || jobTitle || decisionYear || receivedYear || currentPage > 1 || limit !== 12) {
            fetchResults(currentPage, limit);
        } else {
            fetchResults(1, limit);
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    const handleSearchClick = () => {
        updateURL(company, location, caseNumber, jobTitle, decisionYear, receivedYear, 1, limit);
        fetchResults(1, limit);
    };

    const handleClearClick = () => {
        setCompany('');
        setLocation('');
        setCaseNumber('');
        setJobTitle('');
        setDecisionYear('');
        setReceivedYear('');
        setLimit(12);
        updateURL('', '', '', '', '', '', 1, 12);

        setIsLoading(true);
        axios.get(`/api/search/perm`, { params: { page: 1, limit: 12 } })
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

    return (
        <div>
            <div className="search-bar-container glass-panel" style={{ padding: '20px', flexDirection: 'column', gap: '15px' }}>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '15px', width: '100%' }}>
                    <input
                        type="text"
                        className="search-input"
                        placeholder="Company Name"
                        value={company}
                        onChange={(e) => setCompany(e.target.value)}
                        onKeyDown={(e) => e.key === 'Enter' && handleSearchClick()}
                    />
                    <input
                        type="text"
                        className="search-input"
                        placeholder="Location (City or State)"
                        value={location}
                        onChange={(e) => setLocation(e.target.value)}
                        onKeyDown={(e) => e.key === 'Enter' && handleSearchClick()}
                    />
                    <input
                        type="text"
                        className="search-input"
                        placeholder="Case Number"
                        value={caseNumber}
                        onChange={(e) => setCaseNumber(e.target.value)}
                        onKeyDown={(e) => e.key === 'Enter' && handleSearchClick()}
                    />
                    <input
                        type="text"
                        className="search-input"
                        placeholder="Job Title"
                        value={jobTitle}
                        onChange={(e) => setJobTitle(e.target.value)}
                        onKeyDown={(e) => e.key === 'Enter' && handleSearchClick()}
                    />
                    <select
                        className="search-input"
                        value={decisionYear}
                        onChange={(e) => setDecisionYear(e.target.value)}
                        style={{ cursor: 'pointer', appearance: 'none' }}
                    >
                        <option value="">Decision Year</option>
                        {availableYears.map(year => (
                            <option key={`dec-${year}`} value={year}>{year}</option>
                        ))}
                    </select>
                    <select
                        className="search-input"
                        value={receivedYear}
                        onChange={(e) => setReceivedYear(e.target.value)}
                        style={{ cursor: 'pointer', appearance: 'none' }}
                    >
                        <option value="">Received Year</option>
                        {availableYears.map(year => (
                            <option key={`rec-${year}`} value={year}>{year}</option>
                        ))}
                    </select>
                </div>
                <div style={{ display: 'flex', gap: '10px', alignSelf: 'flex-end' }}>
                    <button className="btn btn-secondary" style={{ padding: '8px 20px' }} onClick={handleClearClick} disabled={isLoading}>
                        Clear
                    </button>
                    <button className="btn" style={{ padding: '8px 30px' }} onClick={handleSearchClick} disabled={isLoading}>
                        {isLoading ? (
                            <div style={{ display: 'inline-block', width: '20px', height: '20px', border: '2px solid rgba(255,255,255,0.3)', borderRadius: '50%', borderTopColor: '#fff', animation: 'spin 1s ease-in-out infinite', marginRight: '8px', verticalAlign: 'text-bottom' }} />
                        ) : (
                            <FiSearch size={20} style={{ marginRight: '8px', verticalAlign: 'text-bottom' }} />
                        )}
                        {isLoading ? 'Searching...' : 'Search'}
                    </button>
                </div>
            </div>

            <style>
                {`
                @keyframes spin {
                    to { transform: rotate(360deg); }
                }
                .loading-overlay {
                    display: flex;
                    flex-direction: column;
                    align-items: center;
                    justify-content: center;
                    padding: 60px 20px;
                    color: rgba(255,255,255,0.7);
                }
                .spinner-large {
                    width: 40px;
                    height: 40px;
                    border: 3px solid rgba(255,255,255,0.1);
                    border-radius: 50%;
                    border-top-color: #3b82f6;
                    animation: spin 1s ease-in-out infinite;
                    margin-bottom: 20px;
                }
                `}
            </style>

            <div style={{ marginBottom: '24px', marginTop: '20px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', opacity: 0.8, flexWrap: 'wrap', gap: '10px' }}>
                <div>Found {totalCount} relevant records.</div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }}>
                    <label htmlFor="limit-select">Results per page:</label>
                    <select
                        id="limit-select"
                        value={limit}
                        onChange={(e) => {
                            const newLimit = parseInt(e.target.value);
                            setLimit(newLimit);
                            updateURL(company, location, caseNumber, jobTitle, decisionYear, receivedYear, 1, newLimit);
                            fetchResults(1, newLimit);
                        }}
                        className="search-input"
                        disabled={isLoading}
                        style={{ padding: '6px 12px', width: 'auto', cursor: 'pointer', appearance: 'auto', border: '1px solid rgba(255,255,255,0.2)' }}
                    >
                        <option value={12}>12</option>
                        <option value={24}>24</option>
                        <option value={48}>48</option>
                        <option value={96}>96</option>
                    </select>
                </div>
            </div>

            {isLoading ? (
                <div className="glass-panel loading-overlay">
                    <div className="spinner-large"></div>
                    <h3>Searching PERM Records...</h3>
                    <p>Please wait while we carefully scan the database.</p>
                </div>
            ) : (
                <div className="results-grid">
                    {results.map((caseItem) => (
                        <Link key={caseItem._id} to={`/cases/${caseItem._id}`} style={{ textDecoration: 'none', color: 'inherit' }}>
                            <div className="case-card glass-panel" style={{ height: '100%' }}>
                                <div className="card-header">
                                    <span className="company-name">
                                        {caseItem.EMP_BUSINESS_NAME || 'Unknown Company'}
                                    </span>
                                    <span className="case-number">{caseItem.CASE_NUMBER}</span>
                                </div>

                                <div className="card-body">
                                    <div className="info-row">
                                        <span className="info-label"><FiBriefcase style={{ verticalAlign: 'middle', marginRight: '6px' }} /> Job Title</span>
                                        <span style={{ fontWeight: 500, textAlign: 'right' }}>{caseItem.JOB_TITLE || 'N/A'}</span>
                                    </div>

                                    <div className="info-row">
                                        <span className="info-label"><FiMap style={{ verticalAlign: 'middle', marginRight: '6px' }} /> State / City</span>
                                        <span style={{ textAlign: 'right' }}>{caseItem.EMP_CITY || 'N/A'}, {caseItem.EMP_STATE || 'N/A'}</span>
                                    </div>

                                    <div className="info-row" style={{ marginTop: '8px', paddingTop: '8px', borderTop: '1px solid rgba(255,255,255,0.05)' }}>
                                        <span className="info-label">Status</span>
                                        <span style={{
                                            color: caseItem.CASE_STATUS?.includes('Denied') ? '#ef4444' : '#10b981',
                                            fontWeight: 600,
                                            textAlign: 'right'
                                        }}>
                                            {caseItem.CASE_STATUS || 'N/A'}
                                        </span>
                                    </div>

                                    <div className="info-row">
                                        <span className="info-label">Visa Class</span>
                                        <span style={{ textAlign: 'right' }}>{caseItem.VISA_CLASS || 'N/A'}</span>
                                    </div>

                                    <div className="info-row">
                                        <span className="info-label">NAICS Code</span>
                                        <span style={{ textAlign: 'right' }}>{caseItem.EMP_NAICS_CODE || 'N/A'}</span>
                                    </div>

                                    <div className="info-row">
                                        <span className="info-label" title="SOC Code / Title">SOC Code</span>
                                        <span style={{ textAlign: 'right', maxWidth: '60%' }} title={caseItem.PWD_SOC_TITLE}>
                                            {caseItem.PWD_SOC_CODE || 'N/A'}
                                        </span>
                                    </div>

                                    <div className="info-row">
                                        <span className="info-label">Related PWD Number</span>
                                        <span style={{ textAlign: 'right' }}>{caseItem.JOB_OPP_PWD_NUMBER || 'N/A'}</span>
                                    </div>

                                    <div className="info-row">
                                        <span className="info-label">Wage (OES: {caseItem.PWD_OES_WAGE_LEVEL || 'N/A'})</span>
                                        <span style={{ textAlign: 'right' }}>
                                            {caseItem.PWD_WAGE_RATE ? `$${caseItem.PWD_WAGE_RATE} / ${caseItem.PWD_UNIT_OF_PAY}` : 'N/A'}
                                        </span>
                                    </div>

                                    <div className="info-row">
                                        <span className="info-label">PERM Decision Date</span>
                                        <span style={{ textAlign: 'right' }}>
                                            {caseItem.DECISION_DATE ? new Date(caseItem.DECISION_DATE).toLocaleDateString() : 'N/A'}
                                        </span>
                                    </div>

                                    <div className="info-row">
                                        <span className="info-label">PERM Received Date</span>
                                        <span style={{ textAlign: 'right' }}>
                                            {caseItem.RECEIVED_DATE ? new Date(caseItem.RECEIVED_DATE).toLocaleDateString() : 'N/A'}
                                        </span>
                                    </div>

                                    {caseItem.PWD_DETERMINATION_DATE && (
                                        <div className="info-row" style={{ marginTop: '8px', paddingTop: '8px', borderTop: '1px dashed rgba(255,255,255,0.1)' }}>
                                            <span className="info-label">PWD Determ. Date</span>
                                            <span style={{ textAlign: 'right' }}>
                                                {new Date(caseItem.PWD_DETERMINATION_DATE).toLocaleDateString()}
                                            </span>
                                        </div>
                                    )}

                                    {caseItem.PWD_RECEIVED_DATE && (
                                        <div className="info-row">
                                            <span className="info-label">PWD Received Date</span>
                                            <span style={{ textAlign: 'right' }}>
                                                {new Date(caseItem.PWD_RECEIVED_DATE).toLocaleDateString()}
                                            </span>
                                        </div>
                                    )}

                                    {caseItem.PWD_EXPIRATION_DATE && (
                                        <div className="info-row">
                                            <span className="info-label">PWD Expiration Date</span>
                                            <span style={{ textAlign: 'right' }}>
                                                {new Date(caseItem.PWD_EXPIRATION_DATE).toLocaleDateString()}
                                            </span>
                                        </div>
                                    )}
                                </div>
                            </div>
                        </Link>
                    ))}
                </div>
            )}

            {totalPages > 1 && (
                <div className="pagination">
                    <button
                        className="btn btn-secondary"
                        onClick={() => handlePageChange(currentPage - 1)}
                        disabled={currentPage === 1}
                    >
                        Prev
                    </button>

                    <span className="page-info">
                        Page {currentPage} of {totalPages}
                    </span>

                    <button
                        className="btn btn-secondary"
                        onClick={() => handlePageChange(currentPage + 1)}
                        disabled={currentPage === totalPages}
                    >
                        Next
                    </button>
                </div>
            )}
        </div>
    );
};

export default PermSearchView;
