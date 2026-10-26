export function assertApprovedStagingSource(env = process.env) {
  if (env.CHATFLOW_ENVIRONMENT !== 'isolated-staging' || env.STAGING_REHEARSAL_MODE !== 'infra-only')
    throw new Error('This entry point requires infrastructure-only staging');
  const approved = env.STAGING_APPROVED_COMMIT_SHA;
  if (!/^[a-f0-9]{40}$/.test(approved || '') || !/^[a-f0-9]{40}$/.test(env.RENDER_GIT_COMMIT || '') ||
      approved !== env.RENDER_GIT_COMMIT)
    throw new Error('Deployment commit does not match the explicitly approved staging commit');
  if (env.RENDER_GIT_BRANCH !== 'security/phase-7a-isolated-staging-security-preflight')
    throw new Error('Staging deployment branch is not approved');
  return approved;
}
