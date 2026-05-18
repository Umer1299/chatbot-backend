import assert from 'node:assert/strict';
import { safeLeadExtractorErrorCode, withTimeout } from '../services/leadExtractorSafety.js';

async function run() {
  // invalid JSON handling classification
  assert.equal(safeLeadExtractorErrorCode(new Error('lead_extractor_invalid_json')), 'invalid_json');

  // quota/rate-limit classification
  assert.equal(safeLeadExtractorErrorCode({ status: 429, message: 'rate limit exceeded' }), 'rate_limit_or_quota');

  // missing API key classification
  assert.equal(safeLeadExtractorErrorCode(new Error('Missing API key')), 'auth_or_key');

  // timeout behavior
  await assert.rejects(
    () => withTimeout(() => new Promise((resolve) => setTimeout(resolve, 50)), 5),
    /lead_extractor_timeout/
  );

  console.log('leadExtractorResilience tests passed');
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
