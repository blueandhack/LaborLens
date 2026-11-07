import { useEffect, useState } from 'react';
import ValidationReport from './ValidationReport';

export default function ValidationReportLoader({ source, onClose, reportId: requestedReportId }) {
    const [result, setResult] = useState(null);
    const [error, setError] = useState('');
    const [attempt, setAttempt] = useState(0);
    const reportId = requestedReportId || `validation-${source._id}`;
    useEffect(() => {
        const controller = new AbortController();
        fetch(`/api/upload/auto/report/${source._id}`, { headers: { Authorization: `Bearer ${localStorage.getItem('adminToken')}` }, signal: controller.signal })
            .then(async response => {
                if (!response.ok) throw new Error(response.status === 401 || response.status === 403 ? 'Your session expired. Sign in again to view the report.' : 'Unable to load this validation report.');
                const data = await response.json();
                if (!data.validation) throw new Error('No validation report is available for this file yet.');
                setResult(data);
            }).catch(error => { if (!controller.signal.aborted) setError(error.message); });
        return () => controller.abort();
    }, [source._id, attempt]);
    if (error) return <div id={reportId} className="validation-report"><p role="alert">{error}</p><button className="btn btn-secondary" onClick={() => { setError(''); setAttempt(value => value + 1); }}>Try again</button></div>;
    if (!result) return <div id={reportId} className="validation-report" role="status">Loading validation details…</div>;
    return <ValidationReport source={result} reportId={reportId} onClose={onClose} />;
}

