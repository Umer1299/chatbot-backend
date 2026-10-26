import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import yaml from 'js-yaml';
import * as cheerio from 'cheerio';
import { Receiver } from 'ws';
import OpenAI from 'openai';

test('patched js-yaml parses ordinary documents and bounded merge aliases', () => {
  const config = yaml.load('defaults: &defaults { name: example, enabled: true }\nsite: { <<: *defaults, path: /docs }');
  assert.deepEqual(config.site, { name: 'example', enabled: true, path: '/docs' });
  const aliases = `seed: &seed { a: 1 }\n${Array.from({ length: 12 }, (_, i) => `entry${i}: { <<: *seed }`).join('\n')}`;
  assert.equal(yaml.load(aliases).entry11.a, 1);
});

test('malformed or unsafe YAML is rejected without creating executable objects', () => {
  for (const value of ['field: [unterminated', 'field: *missing', 'field: !!js/function "() => 1"']) {
    assert.throws(() => yaml.load(value), /YAMLException|unknown tag|unidentified alias|unexpected end|unexpected end of the stream/);
  }
  const nested = `${'{ a: '.repeat(25)}true${' }'.repeat(25)}`;
  assert.equal(typeof yaml.load(nested), 'object');
  assert.equal({}.polluted, undefined);
});

test('Cheerio HTML extraction remains parser-only for valid, malformed and large bounded input', async () => {
  const service = await readFile(new URL('../src/services/firecrawlService.js', import.meta.url), 'utf8');
  assert.match(service, /cheerio\.load\(/);
  assert.doesNotMatch(service, /cheerio\.fromURL\(/);
  for (const html of ['<html><title>Business</title><body><main>Service</main></body></html>', '<main><p>Unclosed <b>text']) {
    assert.ok(cheerio.load(html)('main').text().length > 0);
  }
  const hostile = `<main>${'<span>bounded</span>'.repeat(2048)}</main>`;
  assert.equal(cheerio.load(hostile)('main span').length, 2048);
  // Request destination, redirect, timeout and 2 MiB response bounds are tested
  // separately with the real Phase 6E client and no outside network.
});

function parseFrame(bytes, maxPayload = 16) {
  return new Promise((resolve) => {
    const receiver = new Receiver({ isServer: false, maxPayload, skipUTF8Validation: false });
    receiver.once('message', (data, isBinary) => resolve({ data: data.toString(), isBinary }));
    receiver.once('error', error => resolve({ error }));
    receiver.write(Buffer.from(bytes));
  });
}

test('patched ws Receiver accepts a bounded frame and rejects malformed or oversized frames', async () => {
  assert.deepEqual(await parseFrame([0x81, 0x02, 0x6f, 0x6b]), { data: 'ok', isBinary: false });
  assert.match((await parseFrame([0x83, 0x00])).error.message, /invalid opcode/i);
  assert.match((await parseFrame([0x81, 0x11])).error.message, /max payload/i);
  const fragments = [0x01, 0x01, 0x61];
  for (let i = 0; i < 20; i++) fragments.push(0x00, 0x01, 0x61);
  fragments.push(0x80, 0x01, 0x61);
  assert.match((await parseFrame(fragments)).error.message, /max payload/i);
});

test('existing OpenAI SDK construction and Stagehand module import work without provider calls', async () => {
  const sdk = new OpenAI({ apiKey: 'fixture-only' });
  assert.equal(typeof sdk.chat.completions.create, 'function');
  const stagehand = await import('@browserbasehq/stagehand');
  assert.equal(typeof stagehand.Stagehand, 'function');
});
