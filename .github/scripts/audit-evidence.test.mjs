import test from 'node:test';
import assert from 'node:assert/strict';
import { createSanitizer } from './audit-evidence.mjs';

const names = new Set(['app', 'known', 'nested']);
const sanitizer = () => createSanitizer(names);
const advisory = () => ({
  source: 123, name: 'known', dependency: 'known', title: 'Advisory',
  url: 'https://example.test/advisory', severity: 'high', range: '<2',
});
const record = () => ({
  name: 'known', severity: 'high', isDirect: false, via: [advisory()],
  effects: [], range: '<2', nodes: ['node_modules/known'], fixAvailable: true,
});
const report = entry => ({
  auditReportVersion: 2, vulnerabilities: { known: entry },
  metadata: {
    vulnerabilities: { info: 0, low: 0, moderate: 0, high: 1, critical: 0, total: 1 },
    dependencies: { prod: 1, dev: 0, optional: 0, peer: 0, peerOptional: 0, total: 1 },
  },
});

test('valid audit variants and dependency relationships survive', () => {
  const s = sanitizer();
  for (const fixAvailable of [true, false, { name: 'known', version: '2.0.0', isSemVerMajor: true }]) {
    const item = record();
    item.via = ['nested', advisory()];
    item.fixAvailable = fixAvailable;
    assert.equal(s.audit(report(item)).vulnerabilities.known.fixAvailable.isSemVerMajor,
      typeof fixAvailable === 'object' ? true : undefined);
  }
  const value = { name: 'app', dependencies: { known: { version: '1.0.0', dependencies: {
    nested: { version: '2.0.0', dependencies: {} },
  } } } };
  assert.equal(s.tree(value).dependencies.known.dependencies.nested.version, '2.0.0');
  assert.deepEqual(s.tree({ name: 'app', dependencies: {} }).dependencies, {});
});

test('reject malformed vulnerability entries and missing required fields', () => {
  const s = sanitizer();
  for (const item of [{}, null, [], 'bad', 7]) {
    assert.throws(() => s.audit(report(item)));
  }
  for (const key of ['name', 'severity', 'isDirect', 'via', 'effects', 'range', 'nodes', 'fixAvailable']) {
    const item = record();
    delete item[key];
    assert.throws(() => s.audit(report(item)), key);
  }
  for (const change of [
    { severity: 'severe' }, { isDirect: 'false' }, { via: {} }, { via: [] },
    { via: [null] }, { via: [{}] }, { via: [{ ...advisory(), severity: 'urgent' }] },
    { via: [{ ...advisory(), dependency: [] }] }, { effects: [null] },
    { nodes: [null] }, { nodes: ['node_modules/'] },
    { fixAvailable: null }, { fixAvailable: [] }, { fixAvailable: { name: 'known' } },
    { fixAvailable: { name: 'known', version: '2', isSemVerMajor: 'false' } },
  ]) assert.throws(() => s.audit(report({ ...record(), ...change })));
  assert.throws(() => s.audit({ ...report(record()), vulnerabilities: [] }));
  assert.throws(() => s.audit({ ...report(record()), vulnerabilities: { known: { ...record(), name: 'other' } } }));
  const contradictory = report(record());
  contradictory.metadata.vulnerabilities.high = 0;
  contradictory.metadata.vulnerabilities.total = 0;
  assert.throws(() => s.audit(contradictory), /totals disagree/);
});

test('reject primitive and null dependency children before adding their map names', () => {
  const s = sanitizer();
  for (const child of [null, 'string', 3, true]) {
    assert.throws(() => s.tree({ name: 'app', dependencies: { known: child } }));
  }
  assert.throws(() => s.tree({ name: 'app', dependencies: { known: [] } }));
  assert.throws(() => s.tree({ name: 'app', dependencies: { known: { dependencies: { nested: false } } } }));
});

test('redact every package-bearing field using opaque correlated identifiers', () => {
  const s = sanitizer();
  const item = record();
  item.name = 'secret';
  item.via = [{ ...advisory(), name: 'secret', dependency: 'secret' }, 'secret'];
  item.effects = ['secret'];
  item.nodes = ['node_modules/secret/node_modules/nested'];
  item.fixAvailable = { name: 'secret', version: '2', isSemVerMajor: false };
  const output = s.audit({ ...report(item), vulnerabilities: { secret: item } }).vulnerabilities;
  assert.equal(output['redacted-1'].via[0].dependency, 'redacted-1');
  assert.equal(output['redacted-1'].fixAvailable.name, 'redacted-1');
  assert.equal(output['redacted-1'].nodes[0], 'node_modules/redacted-1/node_modules/nested');
  assert.equal(s.tree({ name: 'app', dependencies: { secret: { version: '1' } } })
    .dependencies['redacted-1'].name, 'redacted-1');
  assert.equal(s.redactionCount(), 1);
});
