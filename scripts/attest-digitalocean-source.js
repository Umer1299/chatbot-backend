import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import yaml from 'js-yaml';
import { assertInfraStaging } from '../src/config/infraStaging.js';

const BRANCH = 'security/phase-7b1-digitalocean-private-preflight';
const SHA = /^[a-f0-9]{40}$/;
const ATTESTATION = new URL('../.staging-source-attestation.json', import.meta.url);
const SPEC = new URL('../digitalocean.staging.yaml', import.meta.url);

export function assertDigitalOceanSpec(spec) {
  let config;
  try { config = yaml.load(spec, { json: false }); }
  catch { throw new Error('DigitalOcean spec has malformed or duplicate YAML keys'); }
  const keys = (object, allowed) => object && typeof object === 'object' && !Array.isArray(object) &&
    Object.keys(object).every(key => allowed.includes(key));
  const envKeys = ['DO_DEPLOYED_COMMIT_SHA', 'STAGING_APPROVED_COMMIT_SHA',
    'STAGING_DEPLOYMENT_PLATFORM', 'STAGING_SOURCE_BRANCH', 'NODE_VERSION', 'NODE_ENV',
    'PORT', 'CHATFLOW_ENVIRONMENT', 'STAGING_REHEARSAL_MODE', 'AGENT_WEBSITE_ENABLED',
    'STAGING_DISABLE_LEGACY_FILE_UPLOADS', 'STAGING_DISABLE_SCRAPING',
    'STAGING_DISABLE_PROVIDERS', 'ACCOUNT_AUTH_ENABLED', 'ACCOUNT_PROXY_MODE',
    'STAGING_MAX_CONNECTIONS', 'STAGING_MAX_ACTIVE_REQUESTS', 'STAGING_REQUEST_TIMEOUT_MS'];
  const expected = {
    DO_DEPLOYED_COMMIT_SHA: '${_self.COMMIT_HASH}',
    STAGING_APPROVED_COMMIT_SHA: 'OWNER_APPROVAL_REQUIRED',
    STAGING_DEPLOYMENT_PLATFORM: 'digitalocean',
    STAGING_SOURCE_BRANCH: BRANCH,
    NODE_VERSION: '24.21.0', NODE_ENV: 'production', PORT: '8080',
    CHATFLOW_ENVIRONMENT: 'isolated-staging', STAGING_REHEARSAL_MODE: 'infra-only',
    AGENT_WEBSITE_ENABLED: 'false', STAGING_DISABLE_LEGACY_FILE_UPLOADS: 'true',
    STAGING_DISABLE_SCRAPING: 'true', STAGING_DISABLE_PROVIDERS: 'true',
    ACCOUNT_AUTH_ENABLED: 'false', ACCOUNT_PROXY_MODE: 'direct',
    STAGING_MAX_CONNECTIONS: '8', STAGING_MAX_ACTIVE_REQUESTS: '4',
    STAGING_REQUEST_TIMEOUT_MS: '5000',
  };
  const service = config?.services?.[0];
  if (!keys(config, ['name', 'region', 'services']) ||
      config.name !== 'chatflow-private-health-preflight' || config.region !== 'lon' ||
      !Array.isArray(config.services) || config.services.length !== 1 ||
      !keys(service, ['name', 'environment_slug', 'github', 'source_dir',
        'instance_size_slug', 'instance_count', 'internal_ports', 'build_command', 'run_command', 'envs']) ||
      service.name !== 'preflight-api' || service.environment_slug !== 'node-js' ||
      service.source_dir !== '/' || service.instance_size_slug !== 'basic-xxs' ||
      service.instance_count !== 1 || JSON.stringify(service.internal_ports) !== '[8080]' ||
      !keys(service.github, ['repo', 'branch', 'deploy_on_push']) ||
      service.github.repo !== 'Umer1299/chatbot-backend' || service.github.branch !== BRANCH ||
      service.github.deploy_on_push !== false ||
      service.build_command !== 'npm ci --ignore-scripts && node scripts/attest-digitalocean-source.js' ||
      service.run_command !== 'node scripts/start-infra-staging.js' ||
      !Array.isArray(service.envs) || service.envs.length !== envKeys.length ||
      new Set(service.envs.map(item => item?.key)).size !== envKeys.length ||
      service.envs.some(item => !keys(item, ['key', 'value', 'scope', 'type']) ||
        !envKeys.includes(item.key) || item.value !== expected[item.key] ||
        (item.scope !== undefined && item.scope !== 'RUN_AND_BUILD_TIME' && item.scope !== 'RUN_TIME') ||
        (item.type !== undefined && item.type !== 'GENERAL')) ||
      service.envs.find(item => item.key === 'DO_DEPLOYED_COMMIT_SHA')?.scope !== 'RUN_AND_BUILD_TIME' ||
      service.envs.find(item => item.key === 'STAGING_APPROVED_COMMIT_SHA')?.scope !== 'RUN_AND_BUILD_TIME')
    throw new Error('DigitalOcean spec is not the approved private health-only configuration');
  return true;
}

export function createSourceAttestation({ env, sourceCommit, spec }) {
  assertInfraStaging(env);
  assertDigitalOceanSpec(spec);
  if (env.STAGING_DEPLOYMENT_PLATFORM !== 'digitalocean' ||
      env.STAGING_SOURCE_BRANCH !== BRANCH || !SHA.test(sourceCommit || '') ||
      !SHA.test(env.STAGING_APPROVED_COMMIT_SHA || '') ||
      !SHA.test(env.DO_DEPLOYED_COMMIT_SHA || '') ||
      sourceCommit !== env.STAGING_APPROVED_COMMIT_SHA || sourceCommit !== env.DO_DEPLOYED_COMMIT_SHA)
    throw new Error('DigitalOcean build source or provider commit does not match approval');
  return { platform: 'digitalocean', sourceBranch: BRANCH,
    sourceCommit, approvedCommit: env.STAGING_APPROVED_COMMIT_SHA };
}

if (process.argv[1] && new URL(`file://${process.argv[1]}`).href === import.meta.url) {
  const sourceCommit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const spec = fs.readFileSync(SPEC, 'utf8');
  const attestation = createSourceAttestation({ env: process.env, sourceCommit, spec });
  fs.writeFileSync(ATTESTATION, JSON.stringify(attestation) + '\n', { mode: 0o600, flag: 'w' });
  console.log('DigitalOcean source attestation created for approved source');
}
