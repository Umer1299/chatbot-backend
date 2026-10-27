import fs from 'node:fs';
import { isApprovedVpcId } from './stagingVpc.js';

const DO_BRANCH = 'security/phase-7b1-valkey-vpc-security-repair';
const ATTESTATION = new URL('../../.staging-source-attestation.json', import.meta.url);
const isSha = value => /^[a-f0-9]{40}$/.test(value || '');

export function assertApprovedStagingSource(env = process.env, attestationPath = ATTESTATION) {
  if (env.CHATFLOW_ENVIRONMENT !== 'isolated-staging' || env.STAGING_REHEARSAL_MODE !== 'infra-only')
    throw new Error('This entry point requires infrastructure-only staging');
  const approved = env.STAGING_APPROVED_COMMIT_SHA;
  if (env.DO_DEPLOYED_COMMIT_SHA && env.STAGING_DEPLOYMENT_PLATFORM !== 'digitalocean')
    throw new Error('DigitalOcean provider identity requires the DigitalOcean staging policy');
  if (env.STAGING_DEPLOYMENT_PLATFORM === 'digitalocean') {
    let attestation;
    try { attestation = JSON.parse(fs.readFileSync(attestationPath, 'utf8')); }
    catch { throw new Error('Missing or malformed source build attestation'); }
    if (!isSha(approved) || !isSha(env.DO_DEPLOYED_COMMIT_SHA) ||
        !isSha(attestation.sourceCommit) || !isSha(attestation.approvedCommit) ||
        approved !== env.DO_DEPLOYED_COMMIT_SHA || approved !== attestation.sourceCommit ||
        approved !== attestation.approvedCommit ||
        !isApprovedVpcId(env.STAGING_APPROVED_VPC_ID) ||
        env.STAGING_APPROVED_VPC_ID !== attestation.approvedVpcId ||
        attestation.sourceBranch !== DO_BRANCH || env.STAGING_SOURCE_BRANCH !== DO_BRANCH ||
        env.RENDER_GIT_COMMIT || env.RENDER_GIT_BRANCH ||
        attestation.platform !== 'digitalocean')
      throw new Error('DigitalOcean source identity does not match the approved build');
    return approved;
  }
  if (env.STAGING_DEPLOYMENT_PLATFORM && env.STAGING_DEPLOYMENT_PLATFORM !== 'render')
    throw new Error('Unknown staging deployment platform');
  if (!isSha(approved) || !isSha(env.RENDER_GIT_COMMIT) ||
      approved !== env.RENDER_GIT_COMMIT)
    throw new Error('Deployment commit does not match the explicitly approved staging commit');
  if (env.RENDER_GIT_BRANCH !== 'security/phase-7a-isolated-staging-security-preflight')
    throw new Error('Staging deployment branch is not approved');
  return approved;
}
