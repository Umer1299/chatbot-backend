import pool from '../db/pool.js';

const PROVIDER_MODEL_ALIASES = {
  openai: {
  'gpt-5.5': 'gpt-5',
  'gpt-5.5-pro': 'gpt-5-pro',
  'gpt-5.4': 'gpt-5',
  'gpt-5.4-pro': 'gpt-5-pro',
  'gpt-5.4-mini': 'gpt-5-mini',
  'gpt-5.4-nano': 'gpt-5-nano',
  },
  anthropic: {
    'claude-sonnet-4-6': 'claude-sonnet-4-5-20250929',
    'claude-opus-4-6': 'claude-opus-4-5-20251101',
    'claude-opus-4-7': 'claude-opus-4-5-20251101'
  }
};

function resolveProviderModelId(provider, apiModelId) {
  const aliases = PROVIDER_MODEL_ALIASES[provider] || {};
  return aliases[apiModelId] || apiModelId;
}

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
// - base api_model_id is read from model_configs table
// - provider-specific alias normalization may occur at runtime
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
  const resolvedApiModelId = resolveProviderModelId(row.provider, row.api_model_id);

  if (resolvedApiModelId !== row.api_model_id) {
    console.info('[modelService] Provider model alias applied', {
      modelId: modelIdToUse,
      dbApiModelId: row.api_model_id,
      resolvedApiModelId
    });
  }

  return {
    modelId: modelIdToUse,
    apiModelId: resolvedApiModelId,
    provider: row.provider,
    wasDowngraded: !validation.allowed
  };
}
