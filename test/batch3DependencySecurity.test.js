import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import http from 'node:http';
import { gzipSync } from 'node:zlib';
import { createRequire } from 'node:module';
import { ipKeyGenerator } from 'express-rate-limit';
import { configureTrustedProxy } from '../src/middleware/trustedProxy.js';
import { loadFile } from '../src/services/fileLoader.js';

const require = createRequire(import.meta.url);
const redirects = require('follow-redirects');
const FormData = require('form-data');
const mammothRequire = createRequire(require.resolve('mammoth'));
const JSZip = mammothRequire('jszip');

const app = express();
app.use(express.json({ limit: '1kb' }));
app.use(express.urlencoded({ extended: true, limit: '1kb' }));
app.post('/body', (req, res) => res.json({ value: req.body }));
app.use((error, req, res, next) => res.status(error.status || 500).json({ error: error.type || 'parse error' }));
const server = await new Promise(resolve => {
  const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
});
after(() => new Promise(resolve => server.close(resolve)));
const base = `http://127.0.0.1:${server.address().port}`;

async function postBody(body, contentType = 'application/json', headers = {}) {
  const response = await fetch(base + '/body', { method: 'POST', headers: { 'content-type': contentType, ...headers }, body });
  return { status: response.status, payload: await response.json() };
}

test('patched Express parser accepts bounded JSON, URL encoding, and gzip without weakening the size limit', async () => {
  assert.deepEqual(await postBody('{"hello":"world"}'), { status: 200, payload: { value: { hello: 'world' } } });
  assert.deepEqual(await postBody('name=Alice&count=2', 'application/x-www-form-urlencoded'), { status: 200, payload: { value: { name: 'Alice', count: '2' } } });
  assert.equal((await postBody('{"hello":', 'application/json')).status, 400);
  assert.equal((await postBody(JSON.stringify({ data: 'x'.repeat(2000) }))).status, 413);
  const zipped = gzipSync('{"hello":"compressed"}');
  assert.equal((await postBody(zipped, 'application/json', { 'content-encoding': 'gzip' })).status, 200);
  assert.equal((await postBody(Buffer.concat([zipped, Buffer.from('trailing')]), 'application/json', { 'content-encoding': 'gzip' })).status, 400);
  assert.equal((await postBody(gzipSync(JSON.stringify({ data: 'x'.repeat(2000) })), 'application/json', { 'content-encoding': 'gzip' })).status, 413);
  assert.equal((await postBody('{"after":true}')).status, 200);
});

const received = [];
const destination = http.createServer((req, res) => {
  received.push({ path: req.url, authorization: req.headers.authorization, cookie: req.headers.cookie, custom: req.headers['x.token'], other: req.headers.xxtoken });
  res.end('ok');
});
const source = http.createServer((req, res) => {
  if (req.url === '/loop') { res.writeHead(302, { location: '/loop' }); res.end(); return; }
  if (req.url === '/timeout') return; // The client must enforce its timeout.
  if (req.url === '/same') { res.writeHead(302, { location: '/same-target' }); res.end(); return; }
  if (req.url === '/same-target') { res.end(req.headers.authorization || 'missing'); return; }
  res.writeHead(302, { location: `http://[::1]:${destination.address().port}/target` });
  res.end();
});
await Promise.all([[destination, '::1'], [source, '127.0.0.1']].map(([instance, address]) => new Promise(resolve => instance.listen(0, address, resolve))));
after(() => Promise.all([source, destination].map(instance => new Promise(resolve => instance.close(resolve)))));

function redirectRequest(path, options = {}) {
  return new Promise((resolve, reject) => {
    const req = redirects.http.get({ hostname: '127.0.0.1', port: source.address().port, path, ...options }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => resolve({ status: response.statusCode, body: Buffer.concat(chunks).toString() }));
    });
    req.on('error', reject);
    if (options.timeout) req.setTimeout(options.timeout, () => req.destroy(new Error('request timed out')));
  });
}

test('follow-redirects does not forward array-form credentials to another host', async () => {
  const response = await redirectRequest('/redirect', { headers: ['Authorization', 'Bearer secret-test-only', 'Cookie', 'sid=secret-test-only'] });
  assert.deepEqual(response, { status: 200, body: 'ok' });
  assert.deepEqual(received.at(-1), { path: '/target', authorization: undefined, cookie: undefined, custom: undefined, other: undefined });
  await redirectRequest('/redirect', { headers: { 'X.Token': 'secret-test-only', XxToken: 'not-secret' }, sensitiveHeaders: ['X.Token'] });
  assert.equal(received.at(-1).custom, undefined);
  assert.equal(received.at(-1).other, 'not-secret');
  assert.deepEqual(await redirectRequest('/same', { headers: { authorization: 'Bearer same-host-test-only' } }), { status: 200, body: 'Bearer same-host-test-only' });
  await assert.rejects(redirectRequest('/loop', { maxRedirects: 2 }), /redirect/i);
  await assert.rejects(redirectRequest('/timeout', { timeout: 25 }), /timed out/);
});

test('patched IP key logic uses Express verified peer identity, not forged forwarding headers', async () => {
  const ipApp = express();
  configureTrustedProxy(ipApp, { ACCOUNT_PROXY_MODE: 'trusted', TRUSTED_PROXY_CIDRS: '127.0.0.1/32' });
  ipApp.get('/', (req, res) => res.json({ ip: req.ip, key: ipKeyGenerator(req.ip) }));
  const ipServer = await new Promise(resolve => { const instance = ipApp.listen(0, '127.0.0.1', () => resolve(instance)); });
  try {
    const request = async headers => (await fetch(`http://127.0.0.1:${ipServer.address().port}/`, { headers })).json();
    const direct = await request({});
    const a = await request({ 'x-forwarded-for': '198.51.100.10' });
    const b = await request({ 'x-forwarded-for': '198.51.100.11' });
    const spoofed = await request({ 'x-forwarded-for': '203.0.113.99, 198.51.100.10' });
    assert.equal(direct.ip, '127.0.0.1');
    assert.equal(a.ip, '198.51.100.10');
    assert.equal(b.ip, '198.51.100.11');
    assert.notEqual(a.key, b.key);
    assert.deepEqual(spoofed, a); // Express stops at the nearest untrusted hop.
    assert.equal(ipKeyGenerator('2001:db8:1234:5600::1'), ipKeyGenerator('2001:db8:1234:56ff::2'));
    assert.notEqual(ipKeyGenerator('2001:db8:1234:5600::1'), ipKeyGenerator('2001:db8:1234:5700::1'));
  } finally {
    await new Promise(resolve => ipServer.close(resolve));
  }
});

test('patched form-data safely encodes attacker-controlled multipart names and preserves SDK headers', async () => {
  const form = new FormData();
  form.append('upload', Buffer.from('fixture'), { filename: 'file\r\nX-Injected: yes.txt', contentType: 'text/plain' });
  form.append('field\r\nX-Field-Injected: yes', 'safe');
  const headers = form.getHeaders();
  assert.match(headers['content-type'], /^multipart\/form-data; boundary=/);
  const body = form.getBuffer().toString();
  assert.doesNotMatch(body, /\r\nX-Injected:/);
  assert.doesNotMatch(body, /\r\nX-Field-Injected:/);
  assert.match(body, /Content-Type: text\/plain/);
  assert.equal(form.getLengthSync(), form.getBuffer().length);
});

function docx(documentXml) {
  const zip = new JSZip();
  zip.file('[Content_Types].xml', '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');
  zip.file('_rels/.rels', '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
  zip.file('word/document.xml', documentXml);
  return zip.generateAsync({ type: 'nodebuffer' });
}

test('Mammoth DOCX extraction retains tenant-neutral metadata and propagates broken archives', async () => {
  const xml = '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Tenant fixture</w:t></w:r></w:p></w:body></w:document>';
  const result = await loadFile(await docx(xml), 'fixture.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
  assert.match(result[0].pageContent, /Tenant fixture/);
  assert.equal(result[0].metadata.originalName, 'fixture.docx');
  await assert.rejects(loadFile(Buffer.from('not a zip'), 'broken.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'));
  await assert.rejects(loadFile(await docx('<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p>'), 'invalid-xml.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'));
  const large = await docx(xml.replace('Tenant fixture', 'x'.repeat(100_000)));
  assert.equal((await loadFile(large, 'large.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'))[0].pageContent.length >= 100_000, true);
});
