import test from 'node:test';
import assert from 'node:assert/strict';
import { cachedJSON, getJSON, prefetchJSON, subscribeLoading } from '../src/utils/api.js';

function mockFetch() {
  const calls = [];
  const pending = [];
  globalThis.fetch = url => new Promise(resolve => {
    calls.push(url);
    pending.push(({ status = 200, body = { url } } = {}) => resolve(new Response(JSON.stringify(body), { status })));
  });
  const settle = async options => { while (pending.length) pending.shift()(options); await new Promise(r => setTimeout(r, 0)); };
  return { calls, settle };
}

test('identical requests share one call, and a kept response is reused and shown at once', async () => {
  const net = mockFetch();
  const first = getJSON('/api/a'), second = getJSON('/api/a');
  assert.equal(net.calls.length, 1);
  await net.settle();
  assert.deepEqual(await first, { url: '/api/a' });
  assert.deepEqual(await second, { url: '/api/a' });
  assert.deepEqual(cachedJSON('/api/a'), { url: '/api/a' });
  await getJSON('/api/a');
  assert.equal(net.calls.length, 1, 'kept');
  const polled = getJSON('/api/a', { fresh: true });
  assert.equal(net.calls.length, 2, 'fresh goes back to the network');
  await net.settle(); await polled;
});

test('errors are not kept, so trying again asks the server again', async () => {
  const net = mockFetch();
  const failed = getJSON('/api/b');
  await net.settle({ status: 503, body: { error: 'busy' } });
  await assert.rejects(failed, { message: 'busy', status: 503 });
  assert.equal(cachedJSON('/api/b'), undefined);
  const again = getJSON('/api/b');
  assert.equal(net.calls.length, 2);
  await net.settle(); await again;
});

test('leaving a page stops its wait but not a request another page shares; prefetches are not counted as waiting', async () => {
  const net = mockFetch();
  const counts = [];
  const unsubscribe = subscribeLoading(count => counts.push(count));
  const controller = new AbortController();
  const left = getJSON('/api/c', { signal: controller.signal });
  const stayed = getJSON('/api/c');
  controller.abort();
  await assert.rejects(left, { name: 'AbortError' });
  await net.settle();
  assert.deepEqual(await stayed, { url: '/api/c' });
  prefetchJSON(['/api/d']);
  await net.settle();
  assert.deepEqual(cachedJSON('/api/d'), { url: '/api/d' });
  assert.equal(net.calls.length, 2);
  assert.equal(counts.at(-1), 0);
  assert.equal(Math.max(...counts), 2);
  unsubscribe();
});

test('a restart blip (dropped connection, proxy error page, 502) is retried; the API’s own errors are not', async () => {
  const replies = [() => Promise.reject(new TypeError('Failed to fetch')),
    () => Promise.resolve(new Response('<html>Bad Gateway</html>', { status: 502 })),
    () => Promise.resolve(new Response(JSON.stringify({ ok: 1 }), { status: 200 }))];
  let calls = 0;
  globalThis.fetch = () => replies[calls++]();
  assert.deepEqual(await getJSON('/api/retry-blip'), { ok: 1 });
  assert.equal(calls, 3);

  calls = 0;
  globalThis.fetch = () => { calls++; return Promise.resolve(new Response(JSON.stringify({ error: 'This search is taking too long.' }), { status: 503 })); };
  await assert.rejects(getJSON('/api/retry-real-error'), { message: 'This search is taking too long.', status: 503 });
  assert.equal(calls, 1, 'a real answer is shown at once');

  calls = 0;
  globalThis.fetch = () => { calls++; return Promise.reject(new TypeError('Failed to fetch')); };
  await assert.rejects(getJSON('/api/retry-down'), { message: 'Unable to load this page' });
  assert.equal(calls, 3, 'gives up after two retries');
});
