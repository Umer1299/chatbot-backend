import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import cors from 'cors';
import {
  createCorsPolicy,
  matchesOrigin,
  parseHttpOrigin,
} from '../src/middleware/corsPolicy.js';

const app = express();
app.use(
  cors(
    createCorsPolicy({
      widgetOriginsRaw:
        'https://*.example.com,https://example.com,https://widget.example.net:8443',
      dashboardOriginsRaw: 'https://dashboard.example.com:443',
    }),
  ),
);
app.use((req, res) => res.json({ ok: true }));
app.use((error, req, res, next) =>
  res.status(error.status || 500).json({ error: 'CORS denied' }),
);
const server = await new Promise((resolve) => {
  const s = app.listen(0, '127.0.0.1', () => resolve(s));
});
after(() => new Promise((resolve) => server.close(resolve)));
const base = `http://127.0.0.1:${server.address().port}`;
async function request(path, origin, method = 'GET', extra = {}) {
  const r = await fetch(base + path, {
    method,
    headers: { ...(origin === undefined ? {} : { origin }), ...extra },
  });
  await r.text();
  return r;
}
test('valid widget subdomains/apex/exact port work without credentialed access', async () => {
  for (const origin of [
    'https://sub.example.com',
    'https://deep.sub.example.com',
    'https://example.com',
    'https://widget.example.net:8443',
  ]) {
    const r = await request('/api/chat', origin);
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('access-control-allow-origin'), origin);
    assert.equal(r.headers.get('access-control-allow-credentials'), null);
  }
});
test('malicious lookalikes, scheme/port mismatch and malformed origins are rejected', async () => {
  for (const origin of [
    'https://attackerexample.com',
    'https://sub.example.com.attacker.test',
    'http://sub.example.com',
    'https://sub.example.com:8443',
    'null',
    'garbage',
    'https://user:pass@sub.example.com',
    'https://sub.example.com/path',
    'https://sub.example.com?x=1',
  ]) {
    assert.equal((await request('/api/chat', origin)).status, 403, origin);
  }
});
test('dashboard credentials require exact trusted origin; widget wildcards grant no management access', async () => {
  const good = await request(
    '/api/business/settings',
    'https://dashboard.example.com',
  );
  assert.equal(good.status, 200);
  assert.equal(good.headers.get('access-control-allow-credentials'), 'true');
  assert.equal(
    (await request('/api/business/settings', 'https://sub.example.com')).status,
    403,
  );
  assert.equal(
    (await request('/api/auth/token', 'https://attackerexample.com')).status,
    403,
  );
});
test('preflight contracts and server-to-server requests without Origin remain supported', async () => {
  assert.equal((await request('/api/business/settings')).status, 200);
  const r = await request('/api/chat', 'https://sub.example.com', 'OPTIONS', {
    'access-control-request-method': 'POST',
    'access-control-request-headers': 'x-chatbot-token,content-type',
  });
  assert.equal(r.status, 204);
  assert.match(
    r.headers.get('access-control-allow-headers'),
    /x-chatbot-token/,
  );
});
test('normalization handles case/default ports and wildcard boundaries explicitly', () => {
  assert.equal(
    matchesOrigin('https://SUB.EXAMPLE.COM:443', 'https://*.example.com'),
    true,
  );
  assert.equal(matchesOrigin('https://example.com', '*.example.com'), false);
  assert.equal(
    matchesOrigin('https://sub.example.com:8443', '*.example.com:8443'),
    true,
  );
  assert.equal(matchesOrigin('http://sub.example.com', '*.example.com'), true);
  assert.equal(
    matchesOrigin('https://attackerexample.com', '*.example.com'),
    false,
  );
  for (const origin of [
    'https:\\sub.example.com',
    'file:///tmp/x',
    'data:text/plain,x',
    'https://sub.example.com#x',
  ])
    assert.equal(parseHttpOrigin(origin), null);
});
test('unconfigured widgets remain noncredentialed; absent dashboard trust never permits credentials', () => {
  const policy = createCorsPolicy();
  policy(
    {
      path: '/api/chat',
      method: 'POST',
      headers: { origin: 'https://customer.example' },
    },
    (e, o) => {
      assert.ifError(e);
      assert.equal(o.credentials, false);
      assert.equal(o.origin, true);
    },
  );
  policy(
    {
      path: '/api/leads',
      method: 'GET',
      headers: { origin: 'https://customer.example' },
    },
    (e) => assert.equal(e.status, 403),
  );
  const legacy = createCorsPolicy({
    widgetOriginsRaw: 'https://existing-dashboard.example,*.example.com',
  });
  legacy(
    {
      path: '/api/leads',
      method: 'GET',
      headers: { origin: 'https://existing-dashboard.example' },
    },
    (e, o) => {
      assert.ifError(e);
      assert.equal(o.credentials, true);
    },
  );
  legacy(
    {
      path: '/api/leads',
      method: 'GET',
      headers: { origin: 'https://sub.example.com' },
    },
    (e) => assert.equal(e.status, 403),
  );
});
