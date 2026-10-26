import fs from 'node:fs';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const nonempty = value => typeof value === 'string' && value.length > 0;
const severity = value => ['info', 'low', 'moderate', 'high', 'critical'].includes(value);
const countKeys = ['info', 'low', 'moderate', 'high', 'critical', 'total'];
const dependencyCountKeys = ['prod', 'dev', 'optional', 'peer', 'peerOptional', 'total'];
const counts = (value, keys) => object(value) && keys.every(key =>
  Number.isInteger(value[key]) && value[key] >= 0);
const fail = message => { throw new Error(message); };

// The artifact is public. Only names already in the public lockfile may appear.
export function createSanitizer(publicNames) {
  const withheld = new Map();
  const checkName = name => {
    if (!nonempty(name)) fail('Invalid package identifier');
    if (publicNames.has(name)) return name;
    if (!withheld.has(name)) withheld.set(name, `redacted-${withheld.size + 1}`);
    return withheld.get(name);
  };
  const checkPath = path => {
    if (!nonempty(path) || !path.startsWith('node_modules/')) fail('Unexpected dependency path');
    const parts = path.split('node_modules/').slice(1);
    if (parts.some(part => !nonempty(part.replace(/\/$/, '')))) fail('Invalid dependency path component');
    return parts.map(part => `node_modules/${checkName(part.replace(/\/$/, ''))}`).join('/');
  };
  const via = entry => {
    if (typeof entry === 'string') return checkName(entry);
    if (!object(entry) || !(typeof entry.source === 'number' && Number.isFinite(entry.source) ||
        nonempty(entry.source)) || !nonempty(entry.name) ||
        (entry.dependency !== undefined && !nonempty(entry.dependency)) ||
        !nonempty(entry.title) || !nonempty(entry.url) ||
        !severity(entry.severity) || !nonempty(entry.range)) fail('Invalid npm audit advisory');
    return {
      source: entry.source, name: checkName(entry.name),
      ...(entry.dependency === undefined ? {} : { dependency: checkName(entry.dependency) }),
      title: entry.title, url: entry.url, severity: entry.severity, range: entry.range,
    };
  };
  const fix = entry => {
    if (typeof entry === 'boolean') return entry;
    if (!object(entry) || !nonempty(entry.name) || !nonempty(entry.version) ||
        typeof entry.isSemVerMajor !== 'boolean') fail('Invalid npm audit fixAvailable');
    return { name: checkName(entry.name), version: entry.version, isSemVerMajor: entry.isSemVerMajor };
  };
  const audit = value => {
    if (!object(value) || Object.hasOwn(value, 'error') || value.auditReportVersion !== 2 ||
        !object(value.vulnerabilities) || !object(value.metadata) ||
        !counts(value.metadata.vulnerabilities, countKeys) ||
        !counts(value.metadata.dependencies, dependencyCountKeys)) {
      fail('Invalid npm audit schema');
    }
    const vulnerabilities = Object.fromEntries(Object.entries(value.vulnerabilities).map(([name, record]) => {
      if (!nonempty(name) || !object(record) || record.name !== name ||
          !severity(record.severity) || typeof record.isDirect !== 'boolean' ||
          !Array.isArray(record.via) || record.via.length === 0 ||
          !Array.isArray(record.effects) || !record.effects.every(nonempty) ||
          !nonempty(record.range) || !Array.isArray(record.nodes) || record.nodes.length === 0 ||
          !Object.hasOwn(record, 'fixAvailable')) fail('Invalid npm audit vulnerability');
      return [checkName(name), {
        name: checkName(record.name), severity: record.severity, isDirect: record.isDirect,
        via: record.via.map(via), effects: record.effects.map(checkName),
        range: record.range, nodes: record.nodes.map(checkPath),
        fixAvailable: fix(record.fixAvailable),
      }];
    }));
    const actual = { info: 0, low: 0, moderate: 0, high: 0, critical: 0 };
    for (const record of Object.values(vulnerabilities)) actual[record.severity]++;
    actual.total = Object.keys(value.vulnerabilities).length;
    if (!countKeys.every(key => actual[key] === value.metadata.vulnerabilities[key])) {
      fail('Audit vulnerability totals disagree with entries');
    }
    return {
      auditReportVersion: value.auditReportVersion, vulnerabilities,
      metadata: {
        vulnerabilities: Object.fromEntries(countKeys.map(key => [key, value.metadata.vulnerabilities[key]])),
        dependencies: Object.fromEntries(dependencyCountKeys.map(key => [key, value.metadata.dependencies[key]])),
      },
    };
  };
  const tree = (value, depth = 0, name) => {
    if (depth > 100) fail('Dependency tree too deep');
    // Validate the original child before adding the name from its parent map.
    if (!object(value) || Object.hasOwn(value, 'error') ||
        (value.problems !== undefined && (!Array.isArray(value.problems) || value.problems.length > 0)) ||
        (name === undefined && !nonempty(value.name)) ||
        (value.name !== undefined && !nonempty(value.name)) ||
        (name !== undefined && value.name !== undefined && value.name !== name) ||
        (value.version !== undefined && !nonempty(value.version)) ||
        (value.dependencies !== undefined && !object(value.dependencies))) fail('Invalid npm ls schema');
    return {
      name: checkName(name ?? value.name), version: value.version,
      dependencies: Object.fromEntries(Object.entries(value.dependencies ?? {}).map(([childName, child]) => [
        checkName(childName), tree(child, depth + 1, childName),
      ])),
    };
  };
  const outdated = value => {
    if (!object(value)) fail('Invalid npm outdated schema');
    return Object.fromEntries(Object.entries(value).map(([name, item]) => {
      if (!object(item) || !['current', 'wanted', 'latest'].every(key => nonempty(item[key]))) {
        fail('Invalid npm outdated schema');
      }
      return [checkName(name), { current: item.current, wanted: item.wanted, latest: item.latest }];
    }));
  };
  return { audit, tree, outdated, redactionCount: () => withheld.size };
}

export function validateAuditExecution(raw, exitCode, sanitizer) {
  if (exitCode !== 0 && exitCode !== 1) fail(`Unexpected npm audit exit status: ${exitCode}`);
  const validated = sanitizer.audit(raw);
  const findings = validated.metadata.vulnerabilities.total;
  if ((exitCode === 0) !== (findings === 0)) fail('npm audit exit disagrees with validated findings');
  return validated;
}

export function validateCurrentEvidence(raw, status, sanitizer) {
  const keys = ['auditFull', 'auditProduction', 'dependencyTree', 'outdated'];
  if (!object(status) || !keys.every(key => Object.hasOwn(status, key) && Number.isInteger(status[key])) ||
      Object.keys(status).some(key => !keys.includes(key))) fail('Invalid command exit statuses');
  const full = validateAuditExecution(raw.full, status.auditFull, sanitizer);
  const production = validateAuditExecution(raw.production, status.auditProduction, sanitizer);
  if (status.dependencyTree !== 0) fail(`Unexpected npm ls exit status: ${status.dependencyTree}`);
  const tree = sanitizer.tree(raw.tree);
  if (Object.hasOwn(raw.outdated ?? {}, 'error')) fail('npm outdated returned an error');
  const outdated = sanitizer.outdated(raw.outdated);
  if ((status.outdated === 0) !== (Object.keys(outdated).length === 0) ||
      ![0, 1].includes(status.outdated)) fail(`Unexpected npm outdated exit or report: ${status.outdated}`);
  return { 'audit-full.json': full, 'audit-production.json': production,
    'dependency-tree.json': tree, 'outdated.json': outdated };
}

export function readBaselineFiles(directory) {
  const read = name => {
    const bytes = fs.readFileSync(`${directory}/${name}`, 'utf8');
    if (!bytes.trim()) fail(`Empty baseline ${name}`);
    return bytes;
  };
  const manifest = JSON.parse(read('package.json'));
  const lock = JSON.parse(read('package-lock.json'));
  read('.npmrc');
  if (!object(manifest) || !object(lock) || !object(lock.packages) || !nonempty(lock.name)) {
    fail('Invalid baseline manifest or lockfile');
  }
  return { manifest, lock };
}

export function assertExpectedDependencyTree(tree, expected) {
  const seen = new Set();
  function visit(node) {
    for (const [name, child] of Object.entries(node.dependencies ?? {})) {
      if (Object.hasOwn(expected, name)) {
        if (child.version !== expected[name]) fail(`Unexpected installed ${name} version`);
        seen.add(name);
      }
      visit(child);
    }
  }
  visit(tree);
  for (const name of Object.keys(expected)) {
    if (!seen.has(name)) fail(`Missing installed ${name} dependency`);
  }
}

function main() {
  const raw = 'raw';
  const out = 'reports';
  const lockBytes = fs.readFileSync('package-lock.json');
  const lock = JSON.parse(lockBytes);
  if (!object(lock.packages) || !nonempty(lock.name)) fail('Invalid public lockfile');
  const publicNames = new Set(Object.keys(lock.packages).map(path =>
    path ? path.slice(path.lastIndexOf('node_modules/') + 13) : lock.name));
  const { audit, tree, outdated, redactionCount } = createSanitizer(publicNames);
  const parse = name => {
    const value = JSON.parse(fs.readFileSync(`${raw}/${name}`, 'utf8'));
    if (!object(value)) fail(`${name} is not a JSON object`);
    return value;
  };
  const status = parse('exit-status.json');
  const reports = validateCurrentEvidence({
    full: parse('audit-full.json'), production: parse('audit-production.json'),
    tree: parse('dependency-tree.json'), outdated: parse('outdated.json'),
  }, status, { audit, tree, outdated });
  fs.mkdirSync(out, { recursive: true });
  for (const [name, value] of Object.entries(reports)) {
    fs.writeFileSync(`${out}/${name}`, `${JSON.stringify(value, null, 2)}\n`);
    JSON.parse(fs.readFileSync(`${out}/${name}`, 'utf8'));
  }
  const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
  fs.writeFileSync(`${out}/provenance.json`, `${JSON.stringify({
    auditedCommit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    sourceCommit: execFileSync('git', ['rev-parse', 'HEAD^'], { encoding: 'utf8' }).trim(),
    lockfileGitBlob: execFileSync('git', ['rev-parse', 'HEAD:package-lock.json'], { encoding: 'utf8' }).trim(),
    lockfileSha256: sha256(lockBytes),
    node: process.version,
    npm: execFileSync('npm', ['--version'], { encoding: 'utf8' }).trim(),
    timestamp: new Date().toISOString(),
    exitStatuses: status,
    reportSha256: Object.fromEntries(Object.keys(reports).map(name => [name, sha256(fs.readFileSync(`${out}/${name}`))])),
  }, null, 2)}\n`);
  console.log(`Validated four JSON reports and provenance; ${redactionCount()} unlisted package identifiers redacted.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
