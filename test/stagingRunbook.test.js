import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

test('staging runbook configures auth before readiness and enables agent chat before demo requests', async () => {
  const runbook = await fs.readFile(new URL('../docs/staging-validation.md', import.meta.url), 'utf8');
  const setup = runbook.slice(runbook.indexOf('### Exact manual service setup'), runbook.indexOf('### Staging API smoke request guide'));
  const authConfigured = setup.indexOf('ACCOUNT_AUTH_ENABLED=true');
  const migration = setup.indexOf('npm run staging:migrate');
  const deploy = setup.indexOf('Start/deploy the isolated API');
  const readiness = setup.indexOf('npm run staging:check');
  const onboarding = setup.indexOf('Verify Better Auth onboarding');
  const agentsConfigured = setup.indexOf('Create an agency');
  const deploymentsConfigured = setup.indexOf('For each agent, create a website deployment');
  const flagEnabled = setup.indexOf('set `AGENT_WEBSITE_ENABLED=true`');
  const chatRequests = setup.indexOf('send real HTTP JSON and buffered SSE requests');
  const providerCanary = setup.indexOf('`npm run smoke:provider`');
  const rollback = setup.indexOf('Demonstrate rollback');

  assert.ok(authConfigured < readiness, 'Better Auth must be configured before full readiness check');
  assert.ok(migration < deploy && deploy < readiness, 'migrate before start, then run readiness');
  assert.ok(readiness < onboarding && onboarding < agentsConfigured, 'readiness precedes authenticated onboarding');
  assert.ok(agentsConfigured < deploymentsConfigured && deploymentsConfigured < flagEnabled);
  assert.ok(flagEnabled < chatRequests, 'enable/restart the staging feature before public chat requests');
  assert.ok(chatRequests < providerCanary && providerCanary < rollback);
  assert.match(setup, /feature-disabled safety evidence/);
  assert.match(setup, /Never set this flag on production/);
  assert.match(setup, /A successful provider canary alone does not prove full application RAG/);
});
