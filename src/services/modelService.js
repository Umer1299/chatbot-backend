import pool from '../db/pool.js';

// Plan constants are kept for backwards compatibility with existing imports/UI,
// but model access is no longer restricted by plan.
export const PLAN_HIERARCHY = {
  trial: 0,
  professional: 1,
  growth: 2,
  agency: 3
};

export const PLAN_MODEL_ACCESS = {
  trial: [],
  professional: [],
  growth: [],
  agency: []
};

// ──────────────────────────────────────────────
// getAvailableModels(plan)
// Returns every active model. Plans no longer restrict model access.
// ──────────────────────────────────────────────
export async function getAvailableModels(plan) {
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
// No models are locked by plan anymore.
// ──────────────────────────────────────────────
export async function getLockedModels(plan) {
  return [];
}

// ──────────────────────────────────────────────
// validateModelAccess(modelId, plan)
// Allows any active model regardless of plan.
// Returns { allowed, reason, fallback, requiredPlan }
// ──────────────────────────────────────────────
export async function validateModelAccess(modelId, plan) {
  const modelResult = await pool.query(
    `SELECT model_id, min_plan, branded_name
     FROM model_configs
     WHERE model_id = $1 AND is_active = true`,
    [modelId]
  );

  if (!modelResult.rows.length) {
    return {
      allowed: false,
      reason: 'Model not found or inactive: ' + modelId,
      fallback: 'gpt-4o-mini',
      requiredPlan: null
    };
  }

  return { allowed: true, reason: null, fallback: null, requiredPlan: null };
}

// ──────────────────────────────────────────────
// getSafeModel(requestedModelId, plan)
// Returns { modelId, apiModelId, provider, wasDowngraded }
//
// CRITICAL:
// - api_model_id is read from model_configs table
// - never hardcoded except final emergency fallback
// - plan no longer controls model selection
// ──────────────────────────────────────────────
export async function getSafeModel(requestedModelId, plan) {
  const requested = requestedModelId || 'gpt-4o-mini';

  const apiResult = await pool.query(
    `SELECT api_model_id, provider
     FROM model_configs
     WHERE model_id = $1 AND is_active = true`,
    [requested]
  );

  if (apiResult.rows.length) {
    const row = apiResult.rows[0];
    return {
      modelId: requested,
      apiModelId: row.api_model_id,
      provider: row.provider,
      wasDowngraded: false
    };
  }

  console.warn('[modelService] Requested model unavailable, using emergency fallback', {
    requested,
    plan
  });

  const fb = await pool.query(
    `SELECT api_model_id, provider
     FROM model_configs
     WHERE model_id = 'gpt-4o-mini' AND is_active = true`
  );
  const fbRow = fb.rows[0];

  return {
    modelId: 'gpt-4o-mini',
    apiModelId: fbRow?.api_model_id ?? 'gpt-4o-mini',
    provider: fbRow?.provider ?? 'openai',
    wasDowngraded: true
  };
}
