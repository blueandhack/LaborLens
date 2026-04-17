import React, { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import axios from 'axios';
import { FiArrowLeft } from 'react-icons/fi';

const getStatusClass = (status) => {
    if (!status) return 'other';
    const s = status.toLowerCase();
    if (s.includes('certified') && !s.includes('denied')) return 'certified';
    if (s.includes('denied')) return 'denied';
    if (s.includes('withdrawn')) return 'withdrawn';
    return 'other';
};

const CaseDetailsView = () => {
    const { id } = useParams();
    const navigate = useNavigate();
    const [caseItem, setCaseItem] = useState(null);
    const [isLoading, setIsLoading] = useState(true);

    useEffect(() => {
        axios.get(`/api/cases/${id}`)
            .then(({ data }) => setCaseItem(data))
            .catch(err => console.error('Failed to fetch case details', err))
            .finally(() => setIsLoading(false));
    }, [id]);

    if (isLoading) {
        return (
            <div className="loading-overlay">
                <div className="spinner-large" />
                <h3>Loading case details</h3>
            </div>
        );
    }

    if (!caseItem) {
        return (
            <div style={{ padding: '60px 20px', textAlign: 'center' }}>
                <h2 style={{ marginBottom: '8px', color: 'var(--text-primary)' }}>Case Not Found</h2>
                <p style={{ color: 'var(--text-secondary)', marginBottom: '24px' }}>This case could not be located in the database.</p>
                <button className="btn btn-secondary" onClick={() => navigate(-1)}>
                    <FiArrowLeft size={14} /> Go Back
                </button>
            </div>
        );
    }

    const statusClass = getStatusClass(caseItem.CASE_STATUS);
    const companyName = caseItem.EMPLOYER_LEGAL_BUSINESS_NAME || caseItem.EMP_BUSINESS_NAME || 'Unknown Company';

    const hiddenKeys = ['_id', '__v', 'score', 'createdAt', 'updatedAt'];
    const dataEntries = Object.entries(caseItem)
        .filter(([key, val]) => !hiddenKeys.includes(key) && val !== null && val !== '')
        .sort(([a], [b]) => a.localeCompare(b));

    return (
        <div style={{ animation: 'fadeInUp 0.25s ease' }}>
            <button className="btn btn-secondary" onClick={() => navigate(-1)}
                style={{ marginBottom: '24px', display: 'inline-flex', alignItems: 'center', gap: '6px' }}>
                <FiArrowLeft size={14} /> Back to Results
            </button>

            {/* Header */}
            <div style={{ marginBottom: '28px', paddingBottom: '20px', borderBottom: '1px solid var(--border-color)' }}>
                <div style={{ display: 'flex', alignItems: 'flex-start', gap: '12px', flexWrap: 'wrap' }}>
                    <h2 style={{ fontSize: '22px', fontWeight: 700, color: 'var(--text-primary)', flex: 1 }}>
                        {companyName}
                    </h2>
                    <span className={`status-badge status-badge-${statusClass}`} style={{ fontSize: '12px', padding: '4px 10px' }}>
                        {caseItem.CASE_STATUS || 'Unknown'}
                    </span>
                </div>

                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px', marginTop: '10px' }}>
                    <span style={{
                        background: 'var(--card-badge-bg)', border: '1px solid var(--border-color)',
                        padding: '4px 10px', borderRadius: '6px', fontSize: '13px', color: 'var(--text-secondary)'
                    }}>
                        Case: <span className="mono" style={{ color: 'var(--text-primary)' }}>{caseItem.CASE_NUMBER}</span>
                    </span>
                    {caseItem.VISA_CLASS && (
                        <span style={{
                            background: 'var(--card-badge-bg)', border: '1px solid var(--border-color)',
                            padding: '4px 10px', borderRadius: '6px', fontSize: '13px', color: 'var(--text-secondary)'
                        }}>
                            Visa: <span style={{ color: 'var(--text-primary)', fontWeight: 600 }}>{caseItem.VISA_CLASS}</span>
                        </span>
                    )}
                </div>
            </div>

            {/* All fields grid */}
            <div className="details-grid">
                {dataEntries.map(([key, value]) => {
                    let display = value;
                    if (key.includes('DATE') && value && !isNaN(Date.parse(value))) {
                        display = new Date(value).toLocaleDateString();
                    }
                    const isMonoField = key.includes('CODE') || key.includes('NUMBER') || key.includes('NAICS');

                    return (
                        <div key={key} className="detail-item">
                            <div className="detail-key">{key.replace(/_/g, ' ')}</div>
                            <div className={`detail-value${isMonoField ? ' mono' : ''}`}>
                                {display.toString()}
                            </div>
                        </div>
                    );
                })}
            </div>
        </div>
    );
};

export default CaseDetailsView;
