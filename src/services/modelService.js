import pool from '../db/pool.js';

// Plan hierarchy for access control
export const PLAN_HIERARCHY = {
  trial:        0,
  professional: 1,
  growth:       2,
  agency:       3
};

// Which model_ids each plan can access
// model_id values must match model_configs table
export const PLAN_MODEL_ACCESS = {
  trial:        ['gpt-4o-mini'],
  professional: ['gpt-4o-mini', 'claude-sonnet'],
  growth:       ['gpt-4o-mini', 'gpt-4o', 'claude-sonnet'],
  agency:       ['gpt-4o-mini', 'gpt-4o', 'claude-sonnet', 'claude-opus']
};

// ──────────────────────────────────────────────
// getAvailableModels(plan)
// Returns models this plan can access
// ──────────────────────────────────────────────
export async function getAvailableModels(plan) {
  const allowed = PLAN_MODEL_ACCESS[plan] ?? PLAN_MODEL_ACCESS.trial;

  const result = await pool.query(`
    SELECT model_id, display_name, branded_name,
           provider, min_plan, sort_order
    FROM model_configs
    WHERE model_id = ANY($1) AND is_active = true
    ORDER BY sort_order ASC
  `, [allowed]);

  return result.rows;
}

// ──────────────────────────────────────────────
// getLockedModels(plan)
// Returns models this plan cannot access (for UI)
// ──────────────────────────────────────────────
export async function getLockedModels(plan) {
  const allowed = PLAN_MODEL_ACCESS[plan] ?? PLAN_MODEL_ACCESS.trial;

  const result = await pool.query(`
    SELECT model_id, display_name, branded_name,
           provider, min_plan, sort_order
    FROM model_configs
    WHERE model_id != ALL($1) AND is_active = true
    ORDER BY sort_order ASC
  `, [allowed]);

  return result.rows.map(m => ({ ...m, isLocked: true }));
}

// ──────────────────────────────────────────────
// validateModelAccess(modelId, plan)
// Returns { allowed, reason, fallback, requiredPlan }
// ──────────────────────────────────────────────
export async function validateModelAccess(modelId, plan) {
  const allowed = PLAN_MODEL_ACCESS[plan] ?? PLAN_MODEL_ACCESS.trial;

  if (allowed.includes(modelId)) {
    return { allowed: true, reason: null, fallback: null, requiredPlan: null };
  }

  const modelResult = await pool.query(
    `SELECT min_plan, branded_name
     FROM model_configs WHERE model_id = $1`,
    [modelId]
  );

  if (!modelResult.rows.length) {
    return {
      allowed: false,
      reason: 'Model not found: ' + modelId,
      fallback: allowed.at(-1) ?? 'gpt-4o-mini',
      requiredPlan: null
    };
  }

  const model = modelResult.rows[0];
  return {
    allowed: false,
    reason: model.branded_name + ' requires ' + model.min_plan + ' plan or higher',
    fallback: allowed.at(-1) ?? 'gpt-4o-mini',
    requiredPlan: model.min_plan
  };
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
export async function getSafeModel(requestedModelId, plan) {
  const validation = await validateModelAccess(requestedModelId, plan);

  const modelIdToUse = validation.allowed
    ? requestedModelId
    : (validation.fallback ?? 'gpt-4o-mini');

  if (!validation.allowed) {
    console.warn('[modelService] Plan downgrade', {
      requested: requestedModelId,
      plan,
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
