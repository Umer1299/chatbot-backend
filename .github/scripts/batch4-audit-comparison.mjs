import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { assertExpectedDependencyTree, createSanitizer } from './audit-evidence.mjs';

const read = path => JSON.parse(fs.readFileSync(path, 'utf8'));
const baselineCommit = '5ddd4f9e4451564f744295c613c4266f0787b15f';
execFileSync('git', ['merge-base', '--is-ancestor', baselineCommit, 'HEAD']);
const baselineLock = JSON.parse(execFileSync('git', ['show', `${baselineCommit}:package-lock.json`], { encoding: 'utf8' }));
const lock = read('package-lock.json');
const publicNames = new Set(Object.keys(baselineLock.packages).map(path =>
  path ? path.slice(path.lastIndexOf('node_modules/') + 13) : baselineLock.name));
const sanitizer = createSanitizer(publicNames);
const baseline = {
  full: sanitizer.audit(read('raw/baseline-full.json')),
  production: sanitizer.audit(read('raw/baseline-production.json')),
};
const after = {
  full: read('reports/audit-full.json'),
  production: read('reports/audit-production.json'),
};
const expected = {
  'js-yaml': '4.3.2', undici: '7.30.1', ws: '8.21.0',
  'ipaddr.js': '1.9.1', multer: '2.5.0', 'proxy-addr': '2.0.8',
  protobufjs: '7.6.6', '@grpc/grpc-js': '1.14.6',
  'body-parser': '1.20.9', 'express-rate-limit': '8.6.0',
  'ip-address': '10.7.4', 'follow-redirects': '1.16.1',
  '@xmldom/xmldom': '0.8.15', 'form-data': '4.0.6',
};
for (const [name, version] of Object.entries(expected)) {
  const copies = Object.entries(lock.packages).filter(([path]) =>
    path === `node_modules/${name}` || path.endsWith(`/node_modules/${name}`));
  assert.ok(copies.length > 0, `Missing ${name}`);
  for (const [path, record] of copies) assert.equal(record.version, version, path);
}
const tree = read('reports/dependency-tree.json');
assertExpectedDependencyTree(tree, expected);
assert.equal(execFileSync('git', ['rev-parse', 'HEAD:package.json'], { encoding: 'utf8' }).trim(),
  execFileSync('git', ['rev-parse', `${baselineCommit}:package.json`], { encoding: 'utf8' }).trim());

const advisories = audit => new Set(Object.values(audit.vulnerabilities).flatMap(record =>
  record.via.filter(via => typeof via === 'object').map(via => via.url.split('/').at(-1))));
const comparison = {};
for (const scope of ['full', 'production']) {
  const old = baseline[scope], next = after[scope];
  assert.equal(next.metadata.vulnerabilities.critical, 0, `${scope}: critical regression`);
  for (const name of ['js-yaml', 'undici', 'ws']) {
    assert.ok(old.vulnerabilities[name], `${scope}: baseline missing ${name}`);
    assert.equal(next.vulnerabilities[name], undefined, `${scope}: vulnerable ${name}`);
  }
  const oldIds = advisories(old), nextIds = advisories(next);
  const introducedRecords = Object.keys(next.vulnerabilities).filter(name => !old.vulnerabilities[name]);
  const introducedAdvisories = [...nextIds].filter(id => !oldIds.has(id));
  assert.deepEqual(introducedRecords, [], `${scope}: newly vulnerable package record`);
  assert.deepEqual(introducedAdvisories, [], `${scope}: newly observed advisory`);
  comparison[scope] = {
    before: old.metadata.vulnerabilities,
    after: next.metadata.vulnerabilities,
    eliminatedRecords: Object.keys(old.vulnerabilities).filter(name => !next.vulnerabilities[name]),
    eliminatedAdvisories: [...oldIds].filter(id => !nextIds.has(id)).sort(),
    inheritedRecordsStillAffected: Object.keys(next.vulnerabilities).filter(name =>
      old.vulnerabilities[name] && old.vulnerabilities[name].via.some(via =>
        typeof via === 'string' && ['js-yaml', 'undici', 'ws'].includes(via))),
    introducedRecords, introducedAdvisories,
  };
}
fs.writeFileSync('reports/baseline-comparison.json', `${JSON.stringify({
  baselineCommit,
  baselineLockGitBlob: execFileSync('git', ['rev-parse', `${baselineCommit}:package-lock.json`], { encoding: 'utf8' }).trim(),
  baselineExitStatuses: read('raw/baseline-exit-status.json'),
  comparison,
}, null, 2)}\n`);
JSON.parse(fs.readFileSync('reports/baseline-comparison.json', 'utf8'));
console.log('Validated same-feed parent comparison', JSON.stringify(Object.fromEntries(
  Object.entries(comparison).map(([scope, data]) => [scope, { before: data.before, after: data.after }]))));
