// Model pricing (USD per 1M tokens for internal logging and credit calculation)
export const MODEL_PRICING = {
  'gpt-5.4-mini': { input: 0.75, output: 4.50, modelMultiplier: 1 },
  'gpt-5.4-nano': { input: 0.20, output: 1.25, modelMultiplier: 1 },
  'gpt-4.1-mini': { input: 0.40, output: 1.60, modelMultiplier: 1 },
  'gpt-5-mini': { input: 0.25, output: 2.00, modelMultiplier: 1 },
  'gpt-4o-mini': { input: 0.15, output: 0.60, modelMultiplier: 1 },

  // Anthropic Claude models
  'claude-opus-4-8': { input: 5.00, output: 25.00, contextWindow: 1_000_000, modelMultiplier: 1 },
  'claude-opus-4-7': { input: 5.00, output: 25.00, contextWindow: 1_000_000, modelMultiplier: 1 },
  'claude-opus-4-6': { input: 5.00, output: 25.00, contextWindow: 1_000_000, modelMultiplier: 1 },
  'claude-sonnet-4-6': { input: 3.00, output: 15.00, contextWindow: 1_000_000, modelMultiplier: 1 },
  'claude-haiku-4-5': { input: 1.00, output: 5.00, contextWindow: 200_000, modelMultiplier: 1 },
};

export const CREDIT_VALUE_USD = 0.001;
export const PROFIT_MULTIPLIER = 10;
export const MINIMUM_CREDITS = 1;

const lastEstimatedCostByModel = new Map();

export const ALLOWED_MODELS = new Set(Object.keys(MODEL_PRICING));

export function getModelPricing(model) {
  if (!MODEL_PRICING[model]) {
    console.warn(`Unknown model pricing fallback used for: ${model}`);
    return MODEL_PRICING['gpt-4o-mini'];
  }
  return MODEL_PRICING[model];
}

export function calculateCreditsFromCost(model, tokenCostUsd = 0) {
  const pricing = getModelPricing(model);
  const modelMultiplier = Number(pricing.modelMultiplier || 1);
  const safeTokenCostUsd = Number.isFinite(Number(tokenCostUsd)) ? Number(tokenCostUsd) : 0;

  return Math.max(
    MINIMUM_CREDITS,
    Math.ceil(
      1 + ((safeTokenCostUsd * modelMultiplier * PROFIT_MULTIPLIER) / CREDIT_VALUE_USD)
    )
  );
}

export function recordEstimatedCost(model, estimatedCostUsd = 0) {
  lastEstimatedCostByModel.set(model, Number(estimatedCostUsd) || 0);
}

export function getModelCreditCost(model) {
  return calculateCreditsFromCost(model, lastEstimatedCostByModel.get(model) || 0);
}
