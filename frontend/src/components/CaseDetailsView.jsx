import React, { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import axios from 'axios';
import { FiArrowLeft } from 'react-icons/fi';

const CaseDetailsView = () => {
    const { id } = useParams();
    const navigate = useNavigate();
    const [caseItem, setCaseItem] = useState(null);
    const [isLoading, setIsLoading] = useState(true);

    useEffect(() => {
        const fetchCase = async () => {
            try {
                const { data } = await axios.get(`/api/cases/${id}`);
                setCaseItem(data);
            } catch (error) {
                console.error('Failed to fetch case details', error);
            } finally {
                setIsLoading(false);
            }
        };
        fetchCase();
    }, [id]);

    if (isLoading) {
        return <div style={{ padding: '40px', textAlign: 'center' }}>Loading case details...</div>;
    }

    if (!caseItem) {
        return (
            <div style={{ padding: '40px', textAlign: 'center' }}>
                <h2>Case Not Found</h2>
                <button className="btn" onClick={() => navigate(-1)} style={{ marginTop: '20px' }}>
                    Go Back
                </button>
            </div>
        );
    }

    // Filter out internal MongoDB / React fields
    const hiddenKeys = ['_id', '__v', 'score', 'createdAt', 'updatedAt'];
    const dataEntries = Object.entries(caseItem)
        .filter(([key]) => !hiddenKeys.includes(key) && caseItem[key] !== null)
        .sort(([keyA], [keyB]) => keyA.localeCompare(keyB)); // Sort keys alphabetically for better reading

    return (
        <div className="case-details-container glass-panel" style={{ padding: '30px', animation: 'fadeIn 0.3s' }}>
            <button
                className="btn btn-secondary"
                onClick={() => navigate(-1)}
                style={{ marginBottom: '24px', display: 'flex', alignItems: 'center', gap: '8px' }}
            >
                <FiArrowLeft /> Back to Results
            </button>

            <div style={{ marginBottom: '30px', borderBottom: '1px solid var(--border-color)', paddingBottom: '20px' }}>
                <h2 style={{ fontSize: '28px', color: 'var(--accent-primary)', marginBottom: '8px' }}>
                    {caseItem.EMPLOYER_LEGAL_BUSINESS_NAME || caseItem.EMP_BUSINESS_NAME || 'Unknown Company'}
                </h2>
                <div style={{ display: 'inline-block', background: 'rgba(255,255,255,0.05)', padding: '6px 12px', borderRadius: '6px', fontSize: '14px', color: 'var(--text-secondary)' }}>
                    Case Number: {caseItem.CASE_NUMBER} • Status: <span style={{ color: caseItem.CASE_STATUS?.includes('Denied') ? '#ef4444' : '#10b981', fontWeight: 600 }}>{caseItem.CASE_STATUS}</span>
                </div>
            </div>

            <div className="details-grid">
                {dataEntries.map(([key, value]) => {
                    // Format date if needed
                    let displayValue = value;
                    if (key.includes('DATE') && value && !isNaN(Date.parse(value))) {
                        displayValue = new Date(value).toLocaleDateString();
                    }

                    return (
                        <div key={key} className="detail-item" style={{ breakInside: 'avoid', marginBottom: '16px' }}>
                            <div style={{ fontSize: '12px', color: 'var(--text-secondary)', marginBottom: '4px', wordBreak: 'break-all' }}>
                                {key.replace(/_/g, ' ')}
                            </div>
                            <div style={{ fontSize: '15px', fontWeight: 500, wordBreak: 'break-word', color: 'var(--text-primary)' }}>
                                {displayValue.toString() || 'N/A'}
                            </div>
                        </div>
                    );
                })}
            </div>

            <style dangerouslySetInnerHTML={{
                __html: `
        .details-grid {
          columns: 3 250px;
          column-gap: 30px;
        }
        @media (max-width: 768px) {
          .details-grid {
            columns: 1 !important;
            column-gap: 0;
          }
        }
        @keyframes fadeIn {
          from { opacity: 0; transform: translateY(10px); }
          to { opacity: 1; transform: translateY(0); }
        }
      `}} />
        </div>
    );
};

export default CaseDetailsView;
