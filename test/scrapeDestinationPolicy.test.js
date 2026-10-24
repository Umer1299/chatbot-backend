import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createPublicWebsiteClient, parsePublicWebsiteUrl, resolvePublicWebsite } from '../src/services/scrapeDestinationPolicy.js';

function fakeTransport(routes, calls) {
  return (url, options, callback) => {
    const req = new EventEmitter();
    req.destroy = error => { req.emit('error', error); req.emit('close'); };
    req.end = () => queueMicrotask(() => {
      const host = url.hostname.replace(/^\[|\]$/g, '');
      const perform = (error, address, family) => {
        if (error) return req.destroy(error);
        calls.push({ url: url.href, address, family, options });
        const fixture = routes[url.href];
        if (fixture === 'timeout') return;
        const res = new EventEmitter();
        res.statusCode = fixture?.status ?? 200;
        res.headers = fixture?.headers || { 'content-type': 'text/html' };
        callback(res);
        res.emit('data', Buffer.from(fixture?.body ?? '<h1>Public fixture</h1>'));
        res.emit('end');
        req.emit('close');
      };
      if (host.includes(':') || /^\d+\.\d+\.\d+\.\d+$/.test(host)) {
        perform(null, host, host.includes(':') ? 6 : 4);
      } else {
        options.lookup(host, {}, perform);
      }
    });
    return req;
  };
}

const publicAnswer = [{ address: '93.184.216.34', family: 4 }];

test('canonical parsing rejects private, reserved, mapped, alternate IP forms, credentials, ports and schemes', () => {
  for (const url of [
    'http://127.0.0.1/', 'http://[::1]/', 'http://10.0.0.1/',
    'http://172.16.0.1/', 'http://192.168.1.1/', 'http://[fc00::1]/',
    'http://[fe80::1]/', 'http://[::ffff:127.0.0.1]/',
    'http://169.254.169.254/latest/meta-data/', 'http://100.100.100.200/',
    'http://0x7f000001/', 'http://0177.0.0.1/', 'http://2130706433/',
    'http://198.18.0.1/', 'http://224.0.0.1/', 'http://192.0.2.1/',
    'http://localhost/', 'http://localHost./', 'http://foo.localhost/',
    'https://user:pass@93.184.216.34/', 'https://93.184.216.34:8443/',
    'http://93.184.216.34:443/', 'file:///etc/passwd', 'ftp://example.com/',
    'https://[invalid]/', 'https://93.184.216.34\\@127.0.0.1/',
  ]) assert.throws(() => parsePublicWebsiteUrl(url), /Unsafe scrape destination/, url);
  assert.equal(parsePublicWebsiteUrl('example.com/path').href, 'https://example.com/path');
  assert.equal(parsePublicWebsiteUrl('https://93.184.216.34/path').hostname, '93.184.216.34');
});

test('DNS denies private or mixed answers before any transport call', async () => {
  let requests = 0;
  const request = () => { requests++; throw Error('must not request'); };
  for (const answers of [
    [{ address: '127.0.0.1', family: 4 }],
    [{ address: '169.254.169.254', family: 4 }],
    [{ address: 'fc00::1', family: 6 }],
    [...publicAnswer, { address: '10.0.0.8', family: 4 }],
    [],
  ]) {
    const client = createPublicWebsiteClient({ resolver: async () => answers, httpsRequest: request });
    await assert.rejects(client('https://public.example/path'), /Unsafe scrape destination/);
  }
  assert.equal(requests, 0);
});

test('public HTTPS connects to the vetted answer without a second DNS lookup or credential headers', async () => {
  const calls = [];
  let resolves = 0;
  const transport = fakeTransport({}, calls);
  const client = createPublicWebsiteClient({
    resolver: async () => { resolves++; return resolves === 1 ? publicAnswer : [{ address: '127.0.0.1', family: 4 }]; },
    httpsRequest: transport,
  });
  const response = await client('https://public.example/path');
  assert.equal(response.status, 200);
  assert.match(await response.text(), /Public fixture/);
  assert.equal(resolves, 1);
  assert.equal(calls[0].address, '93.184.216.34');
  assert.equal(calls[0].options.servername, 'public.example');
  assert.equal(calls[0].options.rejectUnauthorized, true);
  assert.equal(calls[0].options.headers.Authorization, undefined);
});

test('each redirect is revalidated and cannot reach private IPs or a rebound hostname', async () => {
  const calls = [];
  const routes = {
    'https://public.example/private': { status: 302, headers: { location: 'http://127.0.0.1/internal' } },
    'https://public.example/rebound': { status: 302, headers: { location: 'https://other.example/' } },
  };
  const transport = fakeTransport(routes, calls);
  const client = createPublicWebsiteClient({
    resolver: async host => host === 'other.example' ? [{ address: '10.0.0.1', family: 4 }] : publicAnswer,
    httpsRequest: transport, httpRequest: transport,
  });
  await assert.rejects(client('https://public.example/private'), /Unsafe scrape destination/);
  await assert.rejects(client('https://public.example/rebound'), /Unsafe scrape destination/);
  assert.deepEqual(calls.map(call => call.url), ['https://public.example/private', 'https://public.example/rebound']);
});

test('public redirect succeeds, loops and excessive hops fail, timeouts and large bodies are bounded', async () => {
  const calls = [];
  const routes = {
    'https://public.example/start': { status: 302, headers: { location: '/final' } },
    'https://public.example/loop': { status: 302, headers: { location: '/loop' } },
    'https://public.example/timeout': 'timeout',
    'https://public.example/large': { body: 'X'.repeat(30) },
  };
  for (let i = 0; i < 8; i++) routes[`https://public.example/hop${i}`] = { status: 302, headers: { location: `/hop${i + 1}` } };
  const transport = fakeTransport(routes, calls);
  const client = createPublicWebsiteClient({ resolver: async () => publicAnswer, httpsRequest: transport, requestTimeoutMs: 20, maxHtmlBytes: 29 });
  assert.equal((await client('https://public.example/start')).url, 'https://public.example/final');
  await assert.rejects(client('https://public.example/loop'), /Unsafe scrape destination/);
  await assert.rejects(client('https://public.example/hop0'), /Unsafe scrape destination/);
  await assert.rejects(client('https://public.example/timeout'), /timed out/);
  await assert.rejects(client('https://public.example/large'), /too large/);
});

test('resolver validates all public answers, including IPv6, and fails closed on DNS errors', async () => {
  const url = parsePublicWebsiteUrl('https://public.example');
  assert.equal((await resolvePublicWebsite(url, async () => [...publicAnswer, { address: '2606:4700:4700::1111', family: 6 }])).address, publicAnswer[0].address);
  await assert.rejects(resolvePublicWebsite(url, async () => { throw Error('DNS failure'); }), /Unsafe scrape destination/);
});
