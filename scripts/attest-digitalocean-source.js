import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import yaml from 'js-yaml';
import { assertInfraStaging } from '../src/config/infraStaging.js';
import { isApprovedVpcId } from '../src/config/stagingVpc.js';

const BRANCH = 'security/phase-7b1-final-compatibility-repair';
const SHA = /^[a-f0-9]{40}$/;
const ATTESTATION = new URL('../.staging-source-attestation.json', import.meta.url);
const SPEC = new URL('../digitalocean.staging.yaml', import.meta.url);

const RUNTIME_CONFIG_KEYS = ['STAGING_ALLOWED_HOST', 'STAGING_REDIS_HOST', 'STAGING_DATABASE_HOST',
  'DATABASE_URL', 'STAGING_DATABASE_URL', 'STAGING_DATABASE_CA_PEM', 'REDIS_URL', 'STAGING_REDIS_URL'];
const SECRET_KEYS = new Set(['DATABASE_URL', 'STAGING_DATABASE_URL', 'STAGING_DATABASE_CA_PEM',
  'REDIS_URL', 'STAGING_REDIS_URL']);

export function assertDigitalOceanSpec(spec, { approvedVpcId, approvedCommit, effective = false } = {}) {
  let config;
  try { config = yaml.load(spec, { json: false }); }
  catch { throw new Error('DigitalOcean spec has malformed or duplicate YAML keys'); }
  const keys = (object, allowed) => object && typeof object === 'object' && !Array.isArray(object) &&
    Object.keys(object).every(key => allowed.includes(key));
  const envKeys = ['DO_DEPLOYED_COMMIT_SHA', 'STAGING_APPROVED_COMMIT_SHA', 'STAGING_APPROVED_VPC_ID',
    'STAGING_DEPLOYMENT_PLATFORM', 'STAGING_SOURCE_BRANCH', 'NODE_VERSION', 'NODE_ENV',
    'PORT', 'CHATFLOW_ENVIRONMENT', 'STAGING_REHEARSAL_MODE', 'AGENT_WEBSITE_ENABLED',
    'STAGING_DISABLE_LEGACY_FILE_UPLOADS', 'STAGING_DISABLE_SCRAPING',
    'STAGING_DISABLE_PROVIDERS', 'ACCOUNT_AUTH_ENABLED', 'ACCOUNT_PROXY_MODE',
    'STAGING_MAX_CONNECTIONS', 'STAGING_MAX_ACTIVE_REQUESTS', 'STAGING_REQUEST_TIMEOUT_MS'];
  const expected = {
    DO_DEPLOYED_COMMIT_SHA: '${_self.COMMIT_HASH}',
    STAGING_APPROVED_COMMIT_SHA: effective ? approvedCommit : 'OWNER_APPROVAL_REQUIRED',
    STAGING_APPROVED_VPC_ID: effective ? approvedVpcId : 'OWNER_VPC_ID_REQUIRED',
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
  const actualKeys = service?.envs?.map(item => item?.key) || [];
  const allowedKeys = effective ? [...envKeys, ...RUNTIME_CONFIG_KEYS, 'STAGING_REDIS_USERNAME'] : envKeys;
  const requiredKeys = effective ? [...envKeys, ...RUNTIME_CONFIG_KEYS] : envKeys;
  const extraValuesValid = service?.envs?.filter(item => !envKeys.includes(item.key)).every(item =>
    (RUNTIME_CONFIG_KEYS.includes(item.key) || item.key === 'STAGING_REDIS_USERNAME') &&
    typeof item.value === 'string' && item.value.trim().length > 0 &&
    item.value !== 'OWNER_APPROVAL_REQUIRED' && item.value !== 'OWNER_VPC_ID_REQUIRED' &&
    item.type === (SECRET_KEYS.has(item.key) ? 'SECRET' : 'GENERAL'));
  if (!keys(config, ['name', 'region', 'vpc', 'services']) ||
      config.name !== 'chatflow-private-health-preflight' || config.region !== 'lon' ||
      !keys(config.vpc, ['id']) ||
      config.vpc.id !== (effective ? approvedVpcId : 'OWNER_VPC_ID_REQUIRED') ||
      (effective && (!isApprovedVpcId(approvedVpcId) || !SHA.test(approvedCommit || ''))) ||
      !Array.isArray(config.services) || config.services.length !== 1 ||
      !keys(service, ['name', 'environment_slug', 'github', 'source_dir',
        'instance_size_slug', 'instance_count', 'internal_ports', 'build_command', 'run_command', 'envs']) ||
      service.name !== 'preflight-api' || service.environment_slug !== 'node-js' ||
      service.source_dir !== '/' || service.instance_size_slug !== 'apps-s-1vcpu-0.5gb' ||
      service.instance_count !== 1 || JSON.stringify(service.internal_ports) !== '[8080]' ||
      !keys(service.github, ['repo', 'branch', 'deploy_on_push']) ||
      service.github.repo !== 'Umer1299/chatbot-backend' || service.github.branch !== BRANCH ||
      service.github.deploy_on_push !== false ||
      service.build_command !== 'npm ci --ignore-scripts && node scripts/attest-digitalocean-source.js' ||
      service.run_command !== 'node scripts/start-infra-staging.js' ||
      !Array.isArray(service.envs) || actualKeys.length < requiredKeys.length ||
      new Set(actualKeys).size !== actualKeys.length ||
      requiredKeys.some(key => !actualKeys.includes(key)) || !extraValuesValid ||
      service.envs.some(item => !keys(item, ['key', 'value', 'scope', 'type']) ||
        !allowedKeys.includes(item.key) ||
        (envKeys.includes(item.key) && item.value !== expected[item.key]) ||
        (item.scope !== undefined && item.scope !== 'RUN_AND_BUILD_TIME' && item.scope !== 'RUN_TIME') ||
        (envKeys.includes(item.key) && item.type !== undefined && item.type !== 'GENERAL')) ||
      service.envs.find(item => item.key === 'DO_DEPLOYED_COMMIT_SHA')?.scope !== 'RUN_AND_BUILD_TIME' ||
      service.envs.find(item => item.key === 'STAGING_APPROVED_COMMIT_SHA')?.scope !== 'RUN_AND_BUILD_TIME' ||
      service.envs.find(item => item.key === 'STAGING_APPROVED_VPC_ID')?.scope !== 'RUN_AND_BUILD_TIME')
    throw new Error('DigitalOcean spec is not the approved private health-only configuration');
  return true;
}

export function createSourceAttestation({ env, sourceCommit, spec }) {
  assertInfraStaging(env);
  assertDigitalOceanSpec(spec);
  if (env.STAGING_DEPLOYMENT_PLATFORM !== 'digitalocean' ||
      env.STAGING_SOURCE_BRANCH !== BRANCH || !SHA.test(sourceCommit || '') ||
      !isApprovedVpcId(env.STAGING_APPROVED_VPC_ID) ||
      !SHA.test(env.STAGING_APPROVED_COMMIT_SHA || '') ||
      !SHA.test(env.DO_DEPLOYED_COMMIT_SHA || '') ||
      sourceCommit !== env.STAGING_APPROVED_COMMIT_SHA || sourceCommit !== env.DO_DEPLOYED_COMMIT_SHA)
    throw new Error('DigitalOcean build source or provider commit does not match approval');
  return { platform: 'digitalocean', sourceBranch: BRANCH,
    sourceCommit, approvedCommit: env.STAGING_APPROVED_COMMIT_SHA,
    approvedVpcId: env.STAGING_APPROVED_VPC_ID };
}

// This must receive an actual provider-exported spec, never a caller's hand-
// assembled replacement. It validates its contents but cannot authenticate its
// provenance or prove live network membership without a deployment record.
export function assertDigitalOceanEffectiveSpec(spec, { approvedVpcId, approvedCommit }) {
  return assertDigitalOceanSpec(spec, { approvedVpcId, approvedCommit, effective: true });
}

if (process.argv[1] && new URL(`file://${process.argv[1]}`).href === import.meta.url) {
  const sourceCommit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const spec = fs.readFileSync(SPEC, 'utf8');
  const attestation = createSourceAttestation({ env: process.env, sourceCommit, spec });
  fs.writeFileSync(ATTESTATION, JSON.stringify(attestation) + '\n', { mode: 0o600, flag: 'w' });
  console.log('DigitalOcean source attestation created for approved source');
}
