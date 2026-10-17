import { test } from "node:test";
import assert from "node:assert/strict";
import { calculateAgentUsage } from "../src/services/agentUsage.js";
import { agentModelAllowed } from "../src/services/agentModelAccess.js";

test("agent credits use provider tokens and model rates, retaining legacy response fields", () => {
  const input = { modelId: "gpt-4o-mini", systemPrompt: "Assistant", messages: [], reply: "Hello" };
  const short = calculateAgentUsage({ ...input, rawUsage: { prompt_tokens: 20, completion_tokens: 5 } });
  const long = calculateAgentUsage({ ...input, rawUsage: { prompt_tokens: 3000, completion_tokens: 8192 } });
  assert.equal(short.inputTokens, 20);
  assert.equal(short.outputTokens, 5);
  assert.equal(long.totalTokens, 11192);
  assert.ok(long.creditsUsed > short.creditsUsed);
  assert.ok(calculateAgentUsage({ ...input, modelId: "claude-sonnet", rawUsage: { input_tokens: 3000, output_tokens: 8192 } }).creditsUsed > long.creditsUsed);
  assert.ok(calculateAgentUsage(input).inputTokens > 0);
});

test("model catalog plan entitlement fails closed for unknown plans", () => {
  assert.equal(agentModelAllowed("trial", "professional"), false);
  assert.equal(agentModelAllowed("professional", "trial"), true);
  assert.equal(agentModelAllowed("free", "trial"), true);
  assert.equal(agentModelAllowed("unknown", "trial"), false);
  assert.equal(agentModelAllowed("agency", "unknown"), false);
});
