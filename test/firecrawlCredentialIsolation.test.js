import { test, mock, after } from 'node:test';
import assert from 'node:assert/strict';

const priorFetch = globalThis.fetch;
const priorEnv = Object.fromEntries(['GCP_VM_URL', 'FIRECRAWL_API_URL', 'FIRECRAWL_FALLBACK_TO_OFFICIAL', 'FIRECRAWL_OFFICIAL_API_KEY', 'FIRECRAWL_SELF_HOSTED_AUTHORIZATION', 'FIRECRAWL_SELF_HOSTED_API_KEY'].map(key => [key, process.env[key]]));
process.env.GCP_VM_URL = 'https://trusted.example';
delete process.env.FIRECRAWL_API_URL;
delete process.env.FIRECRAWL_OFFICIAL_API_KEY;
process.env.FIRECRAWL_FALLBACK_TO_OFFICIAL = 'false';
process.env.FIRECRAWL_SELF_HOSTED_AUTHORIZATION = 'Bearer fixture-only';
delete process.env.FIRECRAWL_SELF_HOSTED_API_KEY;

let directAttempts = 0;
let directFixture = null;
mock.module('../src/services/scrapeDestinationPolicy.js', { namedExports: {
  parsePublicWebsiteUrl: value => { if (value.includes('127.0.0.1')) throw Error('Unsafe scrape destination'); return new URL(value); },
  resolvePublicWebsite: async () => ({ address: '93.184.216.34', family: 4 }),
  fetchPublicWebsite: async () => { directAttempts++; if (directFixture) return directFixture; throw Error('No direct network fixture'); },
} });
const { scrapeWebsite } = await import('../src/services/firecrawlService.js');
after(() => {
  globalThis.fetch = priorFetch;
  for (const [key, value] of Object.entries(priorEnv)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
});

const origin = 'https://trusted.example';
const website = 'https://93.184.216.34/';
const page = { url: website, markdown: 'Controlled website content' };
const json = (value, status = 200, headers = {}) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json', ...headers } });

function fixture(next, behavior = {}) {
  const calls = [];
  globalThis.fetch = async (value, options = {}) => {
    const url = String(value);
    calls.push({ url, token: options.headers?.Authorization, apiKey: options.headers?.['x-api-key'], redirect: options.redirect });
    assert.equal(new URL(url).origin, origin, `off-origin network request: ${url}`);
    assert.equal(options.redirect, 'manual');
    if (behavior[url]) return behavior[url];
    if (url === `${origin}/v1/crawl` && options.method === 'POST') return json({ id: 'job-1' });
    if (url === `${origin}/v1/crawl/job-1`) return json(next === null ? { status: 'completed', pages: [page] } : { status: 'completed', next });
    if (url === `${origin}/v1/scrape`) return json({ data: [page] }); // Explicit same-origin fallback.
    return json({ data: [page] });
  };
  return calls;
}

test('relative and absolute same-origin pagination keep dummy token only on the configured origin', async () => {
  for (const next of ['/v1/crawl/job-1?skip=1', `${origin}/v1/crawl/job-1?skip=2`]) {
    const calls = fixture(next);
    const result = await scrapeWebsite(website);
    assert.equal(result.pages.length, 1);
    assert.equal(calls.length, 3);
    assert.ok(calls.every(call => call.token === 'Bearer fixture-only'));
    assert.equal(directAttempts, 0);
  }
});

test('off-origin, lookalike, downgrade, port, userinfo, scheme and malformed pagination fail closed', async () => {
  for (const next of [
    'https://other.example/steal', 'https://trusted.example.evil.test/steal',
    '//other.example/steal',
    'http://trusted.example/v1/crawl/job-1', 'https://trusted.example:8443/page',
    'https://user@trusted.example/page', 'file:///etc/passwd', 'http://[',
  ]) {
    const calls = fixture(next);
    const result = await scrapeWebsite(website);
    assert.equal(result.pages.length, 1); // Safe same-origin single-page fallback.
    assert.equal(calls.length, 3, next);
    assert.ok(calls.every(call => call.url.startsWith(origin + '/')));
    assert.equal(directAttempts, 0);
  }
});

test('cross-origin pagination redirect never forwards the dummy token; same-origin GET redirect remains usable', async () => {
  let calls = fixture('/v1/next', { [`${origin}/v1/next`]: new Response(null, { status: 302, headers: { location: 'https://other.example/steal' } }) });
  assert.equal((await scrapeWebsite(website)).pages.length, 1);
  assert.equal(calls.length, 4); // Start, poll, same-origin next, safe fallback.
  assert.ok(calls.every(call => call.url.startsWith(origin + '/')));

  calls = fixture('/v1/next', { [`${origin}/v1/next`]: new Response(null, { status: 302, headers: { location: '/v1/final' } }) });
  assert.equal((await scrapeWebsite(website)).pages.length, 1);
  assert.equal(calls.length, 4);
  assert.equal(calls.at(-1).url, `${origin}/v1/final`);
  assert.ok(calls.every(call => call.token === 'Bearer fixture-only'));
});

test('missing next is valid, and self-hosted API keys cannot follow an off-origin next', async () => {
  let calls = fixture(null);
  assert.equal((await scrapeWebsite(website)).pages.length, 1);
  assert.equal(calls.length, 2);
  delete process.env.FIRECRAWL_SELF_HOSTED_AUTHORIZATION;
  process.env.FIRECRAWL_SELF_HOSTED_API_KEY = 'fixture-api-key';
  calls = fixture('https://other.example/steal');
  assert.equal((await scrapeWebsite(website)).pages.length, 1);
  assert.ok(calls.every(call => call.apiKey === 'fixture-api-key' && new URL(call.url).origin === origin));
});

test('worker-boundary website validation rejects private URLs before any Firecrawl request', async () => {
  const calls = fixture(null);
  await assert.rejects(scrapeWebsite('http://127.0.0.1/internal'), /Unsafe scrape destination/);
  assert.equal(calls.length, 0);
});

test('POST redirects are rejected without replaying authorization or payload', async () => {
  const calls = fixture(null, { [`${origin}/v1/crawl`]: new Response(null, { status: 307, headers: { location: 'https://other.example/steal' } }) });
  assert.equal((await scrapeWebsite(website)).pages.length, 1);
  assert.ok(calls.every(call => new URL(call.url).origin === origin));
  assert.equal(calls.filter(call => call.url === `${origin}/v1/crawl`).length, 1);
});

test('legitimate direct HTML fallback still produces a page when the configured provider fails', async () => {
  const calls = fixture(null, {
    [`${origin}/v1/crawl`]: json({ error: 'unavailable' }, 503),
    [`${origin}/v1/scrape`]: json({ error: 'unavailable' }, 503),
  });
  directFixture = {
    ok: true, status: 200, url: website,
    headers: new Headers({ 'content-type': 'text/html' }),
    text: async () => `<html><title>Fixture</title><body><main>${'Public business content. '.repeat(30)}</main></body></html>`,
  };
  try {
    const before = directAttempts;
    const result = await scrapeWebsite(website);
    assert.equal(result.pages.length, 1);
    assert.equal(result.pages[0].metadata.extractionFallback, 'direct-html');
    assert.equal(directAttempts, before + 1);
    assert.ok(calls.every(call => new URL(call.url).origin === origin));
  } finally { directFixture = null; }
});
