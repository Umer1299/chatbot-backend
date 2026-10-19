import { pathToFileURL } from "node:url";
import { getEmbedding } from "../src/services/aiService.js";
import { completeAgent } from "../src/services/agentCompletion.js";

const APPROVAL = "I_APPROVE_ONE_BOUNDED_PROVIDER_CANARY";
const MAX_COST_USD = 0.05;
const REQUEST_TIMEOUT_MS = 20_000;
const OUTPUT_TOKEN_LIMIT = 32;

function configError(message) {
  return Object.assign(new Error(message), { exitCode: 2 });
}

export function parseCanaryConfig(env) {
  if (
    !["isolated-staging", "local-sandbox"].includes(env.CHATFLOW_ENVIRONMENT) ||
    env.LIVE_PROVIDER_TEST_APPROVED !== APPROVAL
  ) {
    throw configError(
      `Refusing live provider calls. Set CHATFLOW_ENVIRONMENT=isolated-staging (or local-sandbox) and LIVE_PROVIDER_TEST_APPROVED=${APPROVAL} only after confirming this is a non-production test.`,
    );
  }

  const mode = env.LIVE_PROVIDER;
  if (!["openai", "anthropic", "combined"].includes(mode)) {
    throw configError(
      "Set LIVE_PROVIDER to openai, anthropic, or combined (OpenAI embeddings plus Anthropic completion).",
    );
  }
  if (!env.LIVE_PROVIDER_MODEL?.trim()) {
    throw configError("LIVE_PROVIDER_MODEL is required for completion.");
  }

  const credentials = {
    openai: Boolean(env.OPENAI_API_KEY?.trim()),
    anthropic: Boolean(env.ANTHROPIC_API_KEY?.trim()),
  };
  const needsOpenAI = mode === "openai" || mode === "combined";
  const needsAnthropic = mode === "anthropic" || mode === "combined";
  if (needsOpenAI && !credentials.openai) {
    throw configError(`OPENAI_API_KEY is required for LIVE_PROVIDER=${mode}.`);
  }
  if (needsAnthropic && !credentials.anthropic) {
    throw configError(`ANTHROPIC_API_KEY is required for LIVE_PROVIDER=${mode}.`);
  }

  const rawCostLimit = env.LIVE_PROVIDER_MAX_COST_USD;
  const rawInputPrice = env.LIVE_PROVIDER_INPUT_USD_PER_1M;
  const rawOutputPrice = env.LIVE_PROVIDER_OUTPUT_USD_PER_1M;
  const rawEmbeddingPrice = env.LIVE_PROVIDER_EMBEDDING_USD_PER_1M;
  const maxCostUsd = Number(rawCostLimit);
  const inputPrice = Number(rawInputPrice);
  const outputPrice = Number(rawOutputPrice);
  const embeddingPrice = needsOpenAI ? Number(rawEmbeddingPrice) : 0;
  const requiredPrices = needsOpenAI
    ? "completion and OpenAI embedding prices"
    : "completion prices (embeddings are not used in this mode)";
  if (
    !rawCostLimit?.trim() || !rawInputPrice?.trim() || !rawOutputPrice?.trim() ||
    (needsOpenAI && !rawEmbeddingPrice?.trim()) ||
    ![maxCostUsd, inputPrice, outputPrice, embeddingPrice].every(Number.isFinite) ||
    maxCostUsd <= 0 || maxCostUsd > MAX_COST_USD ||
    inputPrice <= 0 || outputPrice <= 0 ||
    (needsOpenAI && embeddingPrice <= 0)
  ) {
    throw configError(
      `Supply current ${requiredPrices} per million tokens; LIVE_PROVIDER_MAX_COST_USD must be greater than 0 and no more than $${MAX_COST_USD}.`,
    );
  }

  // Bound one small embedding if selected and one short completion.
  const embeddingInputTokens = needsOpenAI ? 64 : 0;
  const worstCaseCostUsd = (
    embeddingInputTokens * embeddingPrice +
    256 * inputPrice + OUTPUT_TOKEN_LIMIT * outputPrice
  ) / 1_000_000;
  if (worstCaseCostUsd > maxCostUsd) {
    throw configError(
      "Configured request/token bounds exceed LIVE_PROVIDER_MAX_COST_USD; no provider calls were sent.",
    );
  }

  return {
    mode,
    completionProvider: mode === "openai" ? "openai" : "anthropic",
    runEmbedding: needsOpenAI,
    apiModelId: env.LIVE_PROVIDER_MODEL.trim(),
    inputPrice,
    outputPrice,
    embeddingPrice,
    embeddingInputTokens,
    maxCostUsd,
    worstCaseCostUsd,
  };
}

export async function runCanary({
  config,
  embed = getEmbedding,
  complete = completeAgent,
  signalFactory = AbortSignal.timeout,
  write = console.log,
}) {
  const signal = signalFactory(REQUEST_TIMEOUT_MS);
  let vector = null;
  if (config.runEmbedding) {
    vector = await embed("staging provider smoke check", { signal });
    if (!Array.isArray(vector) || vector.length !== 1536 || !vector.every(Number.isFinite)) {
      throw Object.assign(new Error("Embedding canary failed; completion was not sent."), { exitCode: 1 });
    }
  }

  const result = await complete({
    provider: config.completionProvider,
    apiModelId: config.apiModelId,
    systemPrompt: "You are performing a bounded staging smoke test. Reply with the single word OK.",
    messages: [{ role: "user", content: "Reply with OK." }],
    settings: { max_output_tokens: OUTPUT_TOKEN_LIMIT, temperature: 0 },
    signal,
  });
  if (typeof result?.reply !== "string" || !result.reply.trim()) {
    throw Object.assign(new Error("Provider completion canary returned no text."), { exitCode: 1 });
  }

  const usage = result.rawUsage || {};
  const inputTokens = Number(usage.prompt_tokens ?? usage.input_tokens ?? 256);
  const outputTokens = Number(usage.completion_tokens ?? usage.output_tokens ?? OUTPUT_TOKEN_LIMIT);
  const estimatedCostUsd = (
    inputTokens * config.inputPrice +
    outputTokens * config.outputPrice +
    config.embeddingInputTokens * config.embeddingPrice
  ) / 1_000_000;
  if (!Number.isFinite(estimatedCostUsd) || estimatedCostUsd > config.maxCostUsd) {
    throw Object.assign(new Error("Reported usage exceeds LIVE_PROVIDER_MAX_COST_USD; inspect provider billing."), { exitCode: 1 });
  }

  write(JSON.stringify({
    providerMode: config.mode,
    completionProvider: config.completionProvider,
    embeddingTested: config.runEmbedding,
    ...(vector ? { embeddingDimensions: vector.length } : {}),
    completionReceived: true,
    inputTokens: usage.prompt_tokens ?? usage.input_tokens ?? null,
    outputTokens: usage.completion_tokens ?? usage.output_tokens ?? null,
    maxOutputTokens: OUTPUT_TOKEN_LIMIT,
    providerCalls: config.runEmbedding ? 2 : 1,
    estimatedMaximumCostUsd: Number(config.worstCaseCostUsd.toFixed(8)),
    estimatedCostUsd: Number(estimatedCostUsd.toFixed(8)),
    configuredCostLimitUsd: config.maxCostUsd,
  }));
}

export async function main(env = process.env) {
  await runConfiguredCanary({ env });
}

export async function runConfiguredCanary({ env, ...dependencies }) {
  const config = parseCanaryConfig(env);
  await runCanary({ config, ...dependencies });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = error.exitCode || 1;
  });
}
