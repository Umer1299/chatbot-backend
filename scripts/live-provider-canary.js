import { getEmbedding } from "../src/services/aiService.js";
import { completeAgent } from "../src/services/agentCompletion.js";

const approval = "I_APPROVE_ONE_BOUNDED_PROVIDER_CANARY";
if (
  !["isolated-staging", "local-sandbox"].includes(process.env.CHATFLOW_ENVIRONMENT) ||
  process.env.LIVE_PROVIDER_TEST_APPROVED !== approval
) {
  console.error(`Refusing live provider calls. Set CHATFLOW_ENVIRONMENT=isolated-staging (or local-sandbox) and LIVE_PROVIDER_TEST_APPROVED=${approval} after confirming this is a non-production test.`);
  process.exit(2);
}

const provider = process.env.LIVE_PROVIDER;
const apiModelId = process.env.LIVE_PROVIDER_MODEL;
const priceValues = [
  process.env.LIVE_PROVIDER_MAX_COST_USD,
  process.env.LIVE_PROVIDER_INPUT_USD_PER_1M,
  process.env.LIVE_PROVIDER_OUTPUT_USD_PER_1M,
  process.env.LIVE_PROVIDER_EMBEDDING_USD_PER_1M,
];
const [maxCost, inputPrice, outputPrice, embeddingPrice] = priceValues.map(Number);
if (!new Set(["openai", "anthropic"]).has(provider) || !apiModelId) {
  console.error("Set LIVE_PROVIDER=openai|anthropic and an approved LIVE_PROVIDER_MODEL.");
  process.exit(2);
}
if (
  priceValues.some((value) => !value?.trim()) ||
  ![maxCost, inputPrice, outputPrice, embeddingPrice].every(Number.isFinite) ||
  maxCost <= 0 || maxCost > 0.05 ||
  inputPrice <= 0 || outputPrice <= 0 || embeddingPrice <= 0
) {
  console.error("Supply current provider prices per million tokens and a LIVE_PROVIDER_MAX_COST_USD between 0 and 0.05.");
  process.exit(2);
}
// Conservative request bounds: one short embedding (64 input-token allowance),
// one short completion (256 input and at most 32 output tokens).
const worstCaseCost =
  (64 * embeddingPrice + 256 * inputPrice + 32 * outputPrice) / 1_000_000;
if (worstCaseCost > maxCost) {
  console.error("Configured request/token bounds exceed LIVE_PROVIDER_MAX_COST_USD; no provider calls were sent.");
  process.exit(2);
}
if (provider === "openai" && !process.env.OPENAI_API_KEY) {
  console.error("OPENAI_API_KEY is required for the selected test provider.");
  process.exit(2);
}
if (provider === "anthropic" && !process.env.ANTHROPIC_API_KEY) {
  console.error("ANTHROPIC_API_KEY is required for the selected test provider.");
  process.exit(2);
}

const signal = AbortSignal.timeout(20000);
const vector = await getEmbedding("staging provider smoke check", { signal });
if (!Array.isArray(vector) || vector.length !== 1536 || !vector.every(Number.isFinite)) {
  console.error("Embedding canary failed; no model completion was sent.");
  process.exit(1);
}

const result = await completeAgent({
  provider,
  apiModelId,
  systemPrompt: "You are performing a bounded staging smoke test. Reply with the single word OK.",
  messages: [{ role: "user", content: "Reply with OK." }],
  settings: { max_output_tokens: 32, temperature: 0 },
  signal,
});
if (typeof result.reply !== "string" || !result.reply.trim()) {
  console.error("Provider completion canary returned no text.");
  process.exit(1);
}

const usage = result.rawUsage || {};
const estimatedCost = (
  (Number(usage.prompt_tokens ?? usage.input_tokens ?? 256) * inputPrice) +
  (Number(usage.completion_tokens ?? usage.output_tokens ?? 32) * outputPrice) +
  64 * embeddingPrice
) / 1_000_000;
if (estimatedCost > maxCost) {
  console.error("Reported usage exceeds LIVE_PROVIDER_MAX_COST_USD; stop and inspect provider billing before further calls.");
  process.exit(1);
}
console.log(JSON.stringify({
  provider,
  embeddingDimensions: vector.length,
  completionReceived: true,
  inputTokens: usage.prompt_tokens ?? usage.input_tokens ?? null,
  outputTokens: usage.completion_tokens ?? usage.output_tokens ?? null,
  maxOutputTokens: 32,
  providerCalls: 2,
  estimatedMaximumCostUsd: Number(worstCaseCost.toFixed(8)),
  estimatedCostUsd: Number(estimatedCost.toFixed(8)),
  configuredCostLimitUsd: maxCost,
}));
