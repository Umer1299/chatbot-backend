import pool from '../db/pool.js';

// Plan hierarchy for access control

// ──────────────────────────────────────────────
// getAvailableModels(plan)
// Returns models this plan can access
// ──────────────────────────────────────────────
export async function getAvailableModels() {
  const result = await pool.query(`
    SELECT model_id, display_name, branded_name,
           provider, min_plan, sort_order
    FROM model_configs
    WHERE is_active = true
    ORDER BY sort_order ASC
  `);

  return result.rows;
}

// ──────────────────────────────────────────────
// getLockedModels(plan)
// Returns models this plan cannot access (for UI)
// ──────────────────────────────────────────────
export async function getLockedModels() {
  return [];
}

// ──────────────────────────────────────────────
// validateModelAccess(modelId, plan)
// Returns { allowed, reason, fallback, requiredPlan }
// ──────────────────────────────────────────────
export async function validateModelAccess(modelId) {
  const modelResult = await pool.query(
    `SELECT min_plan, branded_name, is_active
     FROM model_configs WHERE model_id = $1`,
    [modelId]
  );

  if (!modelResult.rows.length) {
    return { allowed: false, reason: 'Model not found: ' + modelId, fallback: null, requiredPlan: null };
  }

  const model = modelResult.rows[0];
  if (!model.is_active) {
    return { allowed: false, reason: model.branded_name + ' is not currently available.', fallback: null, requiredPlan: model.min_plan };
  }

  return { allowed: true, reason: null, fallback: null, requiredPlan: null };
}

// ──────────────────────────────────────────────
// getSafeModel(requestedModelId, plan)
// Returns { modelId, apiModelId, provider, wasDowngraded }
//
// CRITICAL:
// - api_model_id is read from model_configs table
// - never hardcoded
// - always returned, never stored in outer scope
// ──────────────────────────────────────────────
export async function getSafeModel(requestedModelId) {
  const validation = await validateModelAccess(requestedModelId);

  const modelIdToUse = validation.allowed
    ? requestedModelId
    : (validation.fallback ?? 'gpt-4o-mini');

  if (!validation.allowed) {
    console.warn('[modelService] Model fallback', {
      requested: requestedModelId,
      using: modelIdToUse,
      reason: validation.reason
    });
  }

  // Always fetch api_model_id from DB — never hardcode
  const apiResult = await pool.query(
    `SELECT api_model_id, provider
     FROM model_configs
     WHERE model_id = $1 AND is_active = true`,
    [modelIdToUse]
  );

  if (!apiResult.rows.length) {
    // Final fallback — gpt-4o-mini must always exist
    console.error('[modelService] Model not in DB, emergency fallback', { modelIdToUse });
    const fb = await pool.query(
      `SELECT api_model_id, provider
       FROM model_configs WHERE model_id = 'gpt-4o-mini'`
    );
    const fbRow = fb.rows[0];
    return {
      modelId: 'gpt-4o-mini',
      apiModelId: fbRow?.api_model_id ?? 'gpt-4o-mini',
      provider: fbRow?.provider ?? 'openai',
      wasDowngraded: true
    };
  }

  const row = apiResult.rows[0];
  return {
    modelId: modelIdToUse,
    apiModelId: row.api_model_id,
    provider: row.provider,
    wasDowngraded: !validation.allowed
  };
}
