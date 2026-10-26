import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { assertExpectedDependencyTree, createSanitizer, readBaselineFiles, validateAuditExecution, validateCurrentEvidence } from './audit-evidence.mjs';

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

const cleanReport = () => ({
  ...report(record()), vulnerabilities: {},
  metadata: { ...report(record()).metadata,
    vulnerabilities: { info: 0, low: 0, moderate: 0, high: 0, critical: 0, total: 0 } },
});
const evidence = (full = report(record()), production = report(record())) => ({
  full, production, tree: { name: 'app', dependencies: { known: { version: '1.0.0' } } },
  outdated: { known: { current: '1.0.0', wanted: '1.0.1', latest: '2.0.0' } },
});
const statuses = () => ({ auditFull: 1, auditProduction: 1, dependencyTree: 0, outdated: 1 });

test('accept clean and vulnerable audits only with matching npm audit exits', () => {
  assert.equal(validateAuditExecution(cleanReport(), 0, sanitizer()).metadata.vulnerabilities.total, 0);
  assert.equal(validateAuditExecution(report(record()), 1, sanitizer()).metadata.vulnerabilities.total, 1);
  const validated = validateCurrentEvidence(evidence(), statuses(), sanitizer());
  assert.equal(validated['audit-full.json'].vulnerabilities.known.name, 'known');
  assert.equal(validated['dependency-tree.json'].dependencies.known.version, '1.0.0');
  assert.doesNotThrow(() => assertExpectedDependencyTree(validated['dependency-tree.json'], { known: '1.0.0' }));
  const clean = evidence(cleanReport(), cleanReport());
  clean.outdated = {};
  assert.deepEqual(validateCurrentEvidence(clean,
    { ...statuses(), auditFull: 0, auditProduction: 0, outdated: 0 }, sanitizer())['outdated.json'], {});
});

test('reject npm error objects even if otherwise valid-shaped', () => {
  for (const value of [
    { error: { code: 'EAUDITBROKEN' } },
    { ...report(record()), error: { code: 'EAUDITBROKEN' } },
    { ...cleanReport(), error: null },
  ]) {
    assert.throws(() => validateAuditExecution(value, 1, sanitizer()));
    assert.throws(() => validateCurrentEvidence(evidence(value), statuses(), sanitizer()));
  }
});

test('reject unexpected, missing, noninteger and contradictory audit exit statuses', () => {
  for (const exit of [2, 127, undefined, '1', 1.5, null]) {
    assert.throws(() => validateAuditExecution(report(record()), exit, sanitizer()));
    assert.throws(() => validateCurrentEvidence(evidence(), { ...statuses(), auditFull: exit }, sanitizer()));
  }
  assert.throws(() => validateAuditExecution(report(record()), 0, sanitizer()));
  assert.throws(() => validateAuditExecution(cleanReport(), 1, sanitizer()));
  assert.throws(() => validateCurrentEvidence(evidence(), { ...statuses(), auditProduction: 0 }, sanitizer()));
  assert.throws(() => validateCurrentEvidence(evidence(cleanReport(), cleanReport()), statuses(), sanitizer()));
  const missing = statuses();
  delete missing.auditFull;
  assert.throws(() => validateCurrentEvidence(evidence(), missing, sanitizer()));
});

test('reject malformed, missing and unsupported audit evidence', () => {
  for (const value of [
    { ...report(record()), auditReportVersion: 3 },
    { ...report(record()), metadata: undefined },
    { ...report(record()), metadata: { ...report(record()).metadata,
      vulnerabilities: { ...report(record()).metadata.vulnerabilities, high: 2 } } },
    { ...report(record()), vulnerabilities: { known: { ...record(), via: [{}] } } },
  ]) assert.throws(() => validateAuditExecution(value, 1, sanitizer()));
  for (const value of ['{"auditReportVersion":', '', 'not json']) {
    assert.throws(() => JSON.parse(value));
  }
  const missing = evidence();
  missing.full = undefined;
  assert.throws(() => validateCurrentEvidence(missing, statuses(), sanitizer()));
});

test('reject incomplete dependency tree, command errors and outdated exit/report disagreement', () => {
  const invalidTree = evidence();
  invalidTree.tree.dependencies.known = null;
  assert.throws(() => validateCurrentEvidence(invalidTree, statuses(), sanitizer()));
  const validTree = validateCurrentEvidence(evidence(), statuses(), sanitizer())['dependency-tree.json'];
  assert.throws(() => assertExpectedDependencyTree(validTree, { known: '2.0.0' }));
  assert.throws(() => assertExpectedDependencyTree({ name: 'app', dependencies: {} }, { known: '1.0.0' }));
  for (const exit of [1, 2, 127]) assert.throws(() => validateCurrentEvidence(evidence(),
    { ...statuses(), dependencyTree: exit }, sanitizer()));
  assert.throws(() => validateCurrentEvidence({ ...evidence(), tree: { name: 'app', problems: ['invalid'] } }, statuses(), sanitizer()));
  assert.throws(() => validateCurrentEvidence(evidence(), { ...statuses(), outdated: 0 }, sanitizer()));
  for (const exit of [2, 127]) assert.throws(() => validateCurrentEvidence(evidence(),
    { ...statuses(), outdated: exit }, sanitizer()));
  assert.throws(() => validateCurrentEvidence({ ...evidence(), outdated: { error: { code: 'EOUTDATED' } } }, statuses(), sanitizer()));
  const empty = evidence();
  empty.outdated = {};
  assert.deepEqual(validateCurrentEvidence(empty, { ...statuses(), outdated: 0 }, sanitizer())['outdated.json'], {});
  assert.throws(() => validateCurrentEvidence(empty, statuses(), sanitizer()));
});

test('missing or empty exact baseline files fail validation', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chatflow-audit-baseline-'));
  try {
    assert.throws(() => readBaselineFiles(dir));
    fs.writeFileSync(path.join(dir, 'package.json'), '{"name":"app"}');
    fs.writeFileSync(path.join(dir, 'package-lock.json'), '{"name":"app","packages":{}}');
    assert.throws(() => readBaselineFiles(dir));
    fs.writeFileSync(path.join(dir, '.npmrc'), '');
    assert.throws(() => readBaselineFiles(dir));
    fs.writeFileSync(path.join(dir, '.npmrc'), 'registry=https://registry.npmjs.org/\n');
    assert.equal(readBaselineFiles(dir).lock.name, 'app');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
