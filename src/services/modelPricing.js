// Model pricing (USD per 1M tokens for internal logging only)
export const MODEL_PRICING = {
  'gpt-5.4-mini': { input: 0.75, output: 4.50 },
  'gpt-5.4-nano': { input: 0.20, output: 1.25 },
  'gpt-4.1-mini': { input: 0.40, output: 1.60 },
  'gpt-5-mini': { input: 0.25, output: 2.00 },
  'gpt-4o-mini': { input: 0.15, output: 0.60 },
};

// Credit cost per message (Chatbase-style)
export const MODEL_CREDIT_COST = {
  'gpt-4o-mini': 1,
  'gpt-5-mini': 5,
  'gpt-4.1-mini': 3,
  'gpt-5.4-mini': 10,
  'gpt-5.4-nano': 2,
};

export const ALLOWED_MODELS = new Set(Object.keys(MODEL_PRICING));

export function getModelPricing(model) {
  if (!MODEL_PRICING[model]) {
    console.warn(`Unknown model pricing fallback used for: ${model}`);
    return MODEL_PRICING['gpt-4o-mini'];
  }
  return MODEL_PRICING[model];
}

export function getModelCreditCost(model) {
  return MODEL_CREDIT_COST[model] || 1; // default to 1 credit
}