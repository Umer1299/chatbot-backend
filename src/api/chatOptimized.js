import express from 'express';
import pool from '../db/pool.js';
import { buildSessionMemoryBlock, getChatHistoryLimit } from '../db/sessionHistory.js';

const originalQuery = pool.query.bind(pool);
const ORIGINAL_HISTORY_QUERY = 'SELECT role, content FROM messages WHERE session_id=$1 ORDER BY created_at ASC LIMIT 30';

const HAIKU_PRICING_USD_PER_1M = {
  input: Number(process.env.CLAUDE_HAIKU_INPUT_USD_PER_1M || 1),
  output: Number(process.env.CLAUDE_HAIKU_OUTPUT_USD_PER_1M || 5),
  multiplier: Number(process.env.CLAUDE_HAIKU_MODEL_MULTIPLIER || 1),
};

function normalizeQuery(value) {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
}

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

async function getOptimizedHistory(sessionId) {
  const limit = getChatHistoryLimit();

  const [historyResult, sessionResult] = await Promise.all([
    originalQuery(
      `SELECT role, content
       FROM (
         SELECT role, content, created_at
         FROM messages
         WHERE session_id = $1
         ORDER BY created_at DESC
         LIMIT $2
       ) recent
       ORDER BY created_at ASC`,
      [sessionId, limit],
    ),
    originalQuery('SELECT collected_data FROM sessions WHERE id = $1', [sessionId]).catch(() => ({ rows: [] })),
  ]);

  const memoryBlock = buildSessionMemoryBlock(sessionResult.rows?.[0] || {});
  if (!memoryBlock) return historyResult;

  return {
    ...historyResult,
    rows: [
      { role: 'user', content: memoryBlock },
      ...historyResult.rows,
    ],
  };
}

pool.query = async function optimizedSessionHistoryQuery(text, params = [], ...rest) {
  if (normalizeQuery(text) === ORIGINAL_HISTORY_QUERY && params?.[0]) {
    return getOptimizedHistory(params[0]);
  }

  return originalQuery(text, params, ...rest);
};

const { default: originalRouter } = await import('./chat.js');
const router = express.Router();

router.use((req, res, next) => {
  patchResponsePricing(res);
  return originalRouter(req, res, next);
});

export default router;
