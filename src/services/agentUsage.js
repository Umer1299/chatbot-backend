// Match the existing public chat credit estimate while retaining provider token
// counts. Agent usage is response metadata; durable billing events are a later phase.
const pricing = {
  "gpt-4o-mini": { input: 0.15, output: 0.6 },
  "gpt-4o": { input: 5, output: 15 },
  "claude-sonnet": { input: 3, output: 15 },
  "claude-opus": { input: 15, output: 75 },
};
const estimate = (value) =>
  String(value || "").trim() ? Math.max(1, Math.ceil(String(value).length / 4)) : 0;
export function calculateAgentUsage({ modelId, apiModelId, systemPrompt, messages, reply, rawUsage }) {
  const model = [modelId, apiModelId].find((id) => pricing[id]) ||
    [modelId, apiModelId].find((id) => /mini|opus|sonnet|gpt-4o/i.test(id || "")) || "gpt-4o-mini";
  const key = pricing[model] ? model : /mini/i.test(model) ? "gpt-4o-mini" :
    /opus/i.test(model) ? "claude-opus" : /sonnet/i.test(model) ? "claude-sonnet" : "gpt-4o";
  const rate = pricing[key];
  const input = Number(rawUsage?.input_tokens ?? rawUsage?.prompt_tokens);
  const output = Number(rawUsage?.output_tokens ?? rawUsage?.completion_tokens);
  const inputTokens = Number.isFinite(input) && input > 0 ? input :
    estimate(systemPrompt) + messages.reduce((sum, m) => sum + estimate(`${m.role}: ${m.content}`), 0);
  const outputTokens = Number.isFinite(output) && output > 0 ? output : estimate(reply);
  const estimatedCostUsd = (inputTokens * rate.input + outputTokens * rate.output) / 1_000_000;
  const creditValueUsd = Number(process.env.CREDIT_VALUE_USD || 0.001);
  const profitMultiplier = Number(process.env.CREDIT_PROFIT_MULTIPLIER || 10);
  const baseCredits = Number(process.env.BASE_CREDITS || 1);
  const minimumCredits = Number(process.env.MINIMUM_CREDITS || 1);
  const creditsUsed = Math.max(minimumCredits,
    Math.ceil(baseCredits + estimatedCostUsd * profitMultiplier / creditValueUsd));
  return { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens,
    estimatedCostUsd: Number(estimatedCostUsd.toFixed(8)), creditsUsed,
    creditValueUsd, profitMultiplier, modelMultiplier: 1 };
}
