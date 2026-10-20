import express from 'express';

const HAIKU_PRICING_USD_PER_1M = {
  input: Number(process.env.CLAUDE_HAIKU_INPUT_USD_PER_1M || 1),
  output: Number(process.env.CLAUDE_HAIKU_OUTPUT_USD_PER_1M || 5),
  multiplier: Number(process.env.CLAUDE_HAIKU_MODEL_MULTIPLIER || 1),
};

function isHaikuModel(model = {}) {
  const text = typeof model === 'string'
    ? model
    : [model?.modelId, model?.apiModelId, model?.model, model?.provider].filter(Boolean).join(' ');

  return /haiku/i.test(text);
}

function calculateCreditsFromCost(estimatedCostUsd) {
  const creditValueUsd = Number(process.env.CREDIT_VALUE_USD || 0.001);
  const profitMultiplier = Number(process.env.CREDIT_PROFIT_MULTIPLIER || 10);
  const baseCredits = Number(process.env.BASE_CREDITS || 1);
  const minimumCredits = Number(process.env.MINIMUM_CREDITS || 1);

  return Math.max(
    minimumCredits,
    Math.ceil(baseCredits + ((estimatedCostUsd * HAIKU_PRICING_USD_PER_1M.multiplier * profitMultiplier) / creditValueUsd)),
  );
}

function applyHaikuPricingToPayload(payload) {
  if (!payload || typeof payload !== 'object' || !payload.usage) return payload;

  const modelInfo = payload.resolvedModel || payload.model || payload.usage?.model;
  if (!isHaikuModel(modelInfo)) return payload;

  const inputTokens = Number(payload.usage.inputTokens || 0);
  const outputTokens = Number(payload.usage.outputTokens || 0);
  const inputCostUsd = (inputTokens / 1_000_000) * HAIKU_PRICING_USD_PER_1M.input;
  const outputCostUsd = (outputTokens / 1_000_000) * HAIKU_PRICING_USD_PER_1M.output;
  const estimatedCostUsd = inputCostUsd + outputCostUsd;
  const creditsUsed = calculateCreditsFromCost(estimatedCostUsd);

  payload.usage = {
    ...payload.usage,
    estimatedCostUsd: Number(estimatedCostUsd.toFixed(8)),
    creditsUsed,
    creditValueUsd: Number(process.env.CREDIT_VALUE_USD || 0.001),
    profitMultiplier: Number(process.env.CREDIT_PROFIT_MULTIPLIER || 10),
    modelMultiplier: HAIKU_PRICING_USD_PER_1M.multiplier,
    pricingOverride: 'claude-haiku',
  };
  payload.creditsUsed = creditsUsed;

  return payload;
}

function patchResponsePricing(res) {
  const originalJson = res.json.bind(res);
  const originalWrite = res.write.bind(res);

  res.json = (payload) => originalJson(applyHaikuPricingToPayload(payload));

  res.write = (chunk, encoding, callback) => {
    const text = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
    if (!text.startsWith('data: ')) return originalWrite(chunk, encoding, callback);

    const jsonText = text.replace(/^data:\s*/, '').trim();
    if (jsonText === '[DONE]') return originalWrite(chunk, encoding, callback);

    try {
      const payload = JSON.parse(jsonText);
      const patched = applyHaikuPricingToPayload(payload);
      const patchedChunk = `data: ${JSON.stringify(patched)}\n\n`;
      return originalWrite(patchedChunk, encoding, callback);
    } catch {
      return originalWrite(chunk, encoding, callback);
    }
  };
}

const { default: originalRouter } = await import('./chat.js');
const router = express.Router();

router.use((req, res, next) => {
  patchResponsePricing(res);
  return originalRouter(req, res, next);
});

export default router;
