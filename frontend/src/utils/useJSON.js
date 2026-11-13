import { useEffect, useState } from 'react';
import { cachedJSON, getJSON } from './api';

// Loads a JSON address, keeping the previous response on screen while the next one
// loads. A null address loads nothing. A kept or prefetched response shows on the
// first paint, without a loading state. 400 errors show the server's message.
export function useJSON(url, failure = 'This data could not load. Please try again.') {
  const [response, setResponse] = useState({ url: null, data: null, error: null });
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    if (!url) return undefined;
    const controller = new AbortController();
    getJSON(url, { signal: controller.signal })
      .then(data => setResponse({ url, data, error: null }))
      .catch(error => { if (!controller.signal.aborted) setResponse({ url, data: null, error: error.status === 400 ? error.message : failure }); });
    return () => controller.abort();
  }, [url, retry, failure]);
  const retryLoad = () => setRetry(value => value + 1);
  if (!url) return { url, data: null, error: null, loading: false, retry: retryLoad };
  const cached = response.url === url ? undefined : cachedJSON(url);
  if (cached !== undefined) return { url, data: cached, error: null, loading: false, retry: retryLoad };
  return { ...response, loading: response.url !== url, retry: retryLoad };
}
