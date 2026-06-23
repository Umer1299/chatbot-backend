import pool from '../db/pool.js';

export const PLAN_HIERARCHY = {
  free: 0,
  trial: 0,
  professional: 1,
  growth: 2,
  agency: 3
};

export const PLAN_MODEL_ACCESS = {
  free: [],
  trial: [],
  professional: [],
  growth: [],
  agency: []
};

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

export async function getLockedModels(plan) {
  return [];
}

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
