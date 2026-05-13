import 'dotenv/config';
import pool from '../db/pool.js';
import { resolveCanonicalModelId } from '../services/modelService.js';

async function run() {
  const checks = [];

  const canonical = await resolveCanonicalModelId('gpt-4o-mini');
  checks.push(['canonical model_id input', canonical?.modelId === 'gpt-4o-mini']);

  const apiModel = await resolveCanonicalModelId('claude-sonnet-4-5-20250929');
  checks.push(['api_model_id input', Boolean(apiModel?.modelId)]);

  const legacy = await resolveCanonicalModelId('claude-sonnet');
  checks.push(['legacy alias input', legacy?.modelId === 'claude-sonnet-4-5-20250929']);

  const invalid = await resolveCanonicalModelId('fake-model-xyz');
  checks.push(['invalid ID', invalid === null]);

  const inactiveRow = await pool.query(
    `SELECT model_id FROM model_configs WHERE is_active = false ORDER BY sort_order ASC NULLS LAST LIMIT 1`
  );
  if (inactiveRow.rows[0]?.model_id) {
    const inactive = await resolveCanonicalModelId(inactiveRow.rows[0].model_id);
    checks.push(['inactive model', inactive?.isActive === false]);
  } else {
    checks.push(['inactive model', true]);
    console.log('ℹ️ No inactive models present in DB; skipped explicit inactive-row lookup.');
  }

  let failed = 0;
  for (const [name, ok] of checks) {
    console.log(`${ok ? '✅' : '❌'} ${name}`);
    if (!ok) failed++;
  }

  await pool.end();
  if (failed) process.exit(1);
}

run().catch(async (err) => {
  console.error('❌ model normalization check failed:', err.message);
  try { await pool.end(); } catch {}
  process.exit(1);
});
