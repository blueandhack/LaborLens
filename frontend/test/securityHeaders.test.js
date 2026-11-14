import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

test('the production CSP permits each fixed executable inline script by hash', async () => {
  const [html, nginxPolicy, backendPolicy] = await Promise.all([
    readFile(new URL('../index.html', import.meta.url), 'utf8'),
    readFile(new URL('../security-headers.conf', import.meta.url), 'utf8'),
    readFile(new URL('../../backend/services/httpSecurity.js', import.meta.url), 'utf8'),
  ]);
  const scripts = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)]
    .map(match => match[1]).filter(body => body.trim());
  assert.ok(scripts.length > 0);
  for (const body of scripts) {
    const hash = createHash('sha256').update(body).digest('base64');
    assert.match(nginxPolicy, new RegExp(hash.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.match(backendPolicy, new RegExp(hash.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
  assert.doesNotMatch(nginxPolicy, /script-src[^;]*unsafe-inline/);
});
