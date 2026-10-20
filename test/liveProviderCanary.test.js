import test from "node:test";
import assert from "node:assert/strict";
import {
  parseCanaryConfig,
  runConfiguredCanary,
} from "../scripts/live-provider-canary.js";

const approval = "I_APPROVE_ONE_BOUNDED_PROVIDER_CANARY";
const baseEnv = (mode, extra = {}) => ({
  CHATFLOW_ENVIRONMENT: "isolated-staging",
  LIVE_PROVIDER_TEST_APPROVED: approval,
  LIVE_PROVIDER: mode,
  LIVE_PROVIDER_MODEL: "mock-model",
  LIVE_PROVIDER_MAX_COST_USD: "0.01",
  LIVE_PROVIDER_INPUT_USD_PER_1M: "1",
  LIVE_PROVIDER_OUTPUT_USD_PER_1M: "2",
  ...extra,
});

function fakeProviders(calls) {
  return {
    embed: async (_text, options) => {
      calls.push(["embedding", options]);
      return Array(1536).fill(0.25);
    },
    complete: async (request) => {
      calls.push(["completion", request]);
      return {
        reply: "OK",
        rawUsage: { input_tokens: 20, output_tokens: 4 },
      };
    },
    signalFactory: (timeout) => ({ timeout }),
    write: () => {},
  };
}

test("Anthropic-only canary runs completion without OpenAI key or embedding price", async () => {
  const config = parseCanaryConfig(baseEnv("anthropic", {
    ANTHROPIC_API_KEY: "test-anthropic-key",
  }));
  const calls = [];
  await runConfiguredCanary({
    env: baseEnv("anthropic", { ANTHROPIC_API_KEY: "test-anthropic-key" }),
    ...fakeProviders(calls),
  });

  assert.equal(config.runEmbedding, false);
  assert.equal(config.completionProvider, "anthropic");
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], "completion");
  assert.equal(calls[0][1].provider, "anthropic");
});

test("OpenAI-only canary tests OpenAI embedding and completion", async () => {
  const config = parseCanaryConfig(baseEnv("openai", {
    OPENAI_API_KEY: "test-openai-key",
    LIVE_PROVIDER_EMBEDDING_USD_PER_1M: "0.1",
  }));
  const calls = [];
  await runConfiguredCanary({
    env: baseEnv("openai", {
      OPENAI_API_KEY: "test-openai-key",
      LIVE_PROVIDER_EMBEDDING_USD_PER_1M: "0.1",
    }),
    ...fakeProviders(calls),
  });

  assert.equal(config.runEmbedding, true);
  assert.equal(config.completionProvider, "openai");
  assert.deepEqual(calls.map(([kind]) => kind), ["embedding", "completion"]);
  assert.equal(calls[1][1].provider, "openai");
});

test("combined mode tests OpenAI embeddings and Anthropic completion", async () => {
  const config = parseCanaryConfig(baseEnv("combined", {
    OPENAI_API_KEY: "test-openai-key",
    ANTHROPIC_API_KEY: "test-anthropic-key",
    LIVE_PROVIDER_EMBEDDING_USD_PER_1M: "0.1",
  }));
  const calls = [];
  await runConfiguredCanary({
    env: baseEnv("combined", {
      OPENAI_API_KEY: "test-openai-key",
      ANTHROPIC_API_KEY: "test-anthropic-key",
      LIVE_PROVIDER_EMBEDDING_USD_PER_1M: "0.1",
    }),
    ...fakeProviders(calls),
  });

  assert.deepEqual(calls.map(([kind]) => kind), ["embedding", "completion"]);
  assert.equal(calls[1][1].provider, "anthropic");
});

test("missing selected credentials block calls while unused credentials are not required", async () => {
  let calls = 0;
  const dependencies = {
    embed: async () => { calls++; },
    complete: async () => { calls++; },
  };
  await assert.rejects(
    runConfiguredCanary({ env: baseEnv("anthropic"), ...dependencies }),
    /ANTHROPIC_API_KEY is required/,
  );
  await assert.rejects(
    runConfiguredCanary({
      env: baseEnv("openai", { LIVE_PROVIDER_EMBEDDING_USD_PER_1M: "0.1" }),
      ...dependencies,
    }),
    /OPENAI_API_KEY is required/,
  );
  await assert.rejects(
    runConfiguredCanary({
      env: baseEnv("combined", {
        OPENAI_API_KEY: "test-openai-key",
        LIVE_PROVIDER_EMBEDDING_USD_PER_1M: "0.1",
      }),
      ...dependencies,
    }),
    /ANTHROPIC_API_KEY is required/,
  );
  assert.equal(calls, 0);
});

test("unsupported provider combinations fail with a clear validation error", () => {
  assert.throws(
    () => parseCanaryConfig(baseEnv("openai+anthropic", {
      OPENAI_API_KEY: "test-openai-key",
      ANTHROPIC_API_KEY: "test-anthropic-key",
      LIVE_PROVIDER_EMBEDDING_USD_PER_1M: "0.1",
    })),
    /openai, anthropic, or combined/,
  );
});

test("cost ceiling rejects an oversized call before invoking providers", async () => {
  const env = baseEnv("anthropic", {
    ANTHROPIC_API_KEY: "test-anthropic-key",
    LIVE_PROVIDER_INPUT_USD_PER_1M: "1000",
    LIVE_PROVIDER_OUTPUT_USD_PER_1M: "1000",
  });
  let calls = 0;
  await assert.rejects(
    runConfiguredCanary({
      env,
      embed: async () => { calls++; },
      complete: async () => { calls++; },
    }),
    /request\/token bounds exceed/,
  );
  assert.equal(calls, 0);
  assert.throws(
    () => parseCanaryConfig(baseEnv("anthropic", {
      ANTHROPIC_API_KEY: "test-anthropic-key",
      LIVE_PROVIDER_MAX_COST_USD: "0.051",
    })),
    /no more than \$0.05/,
  );
});

test("provider calls receive a 20-second timeout signal", async () => {
  const config = parseCanaryConfig(baseEnv("anthropic", {
    ANTHROPIC_API_KEY: "test-anthropic-key",
  }));
  const calls = [];
  const deps = fakeProviders(calls);
  await runConfiguredCanary({
    env: baseEnv("anthropic", { ANTHROPIC_API_KEY: "test-anthropic-key" }),
    ...deps,
  });
  assert.deepEqual(calls[0][1].signal, { timeout: 20_000 });
});

test("missing execution approval blocks all provider calls", async () => {
  const env = baseEnv("anthropic", {
    ANTHROPIC_API_KEY: "test-anthropic-key",
  });
  delete env.LIVE_PROVIDER_TEST_APPROVED;
  let calls = 0;
  await assert.rejects(
    runConfiguredCanary({
      env,
      embed: async () => { calls++; },
      complete: async () => { calls++; },
    }),
    /Refusing live provider calls/,
  );
  assert.equal(calls, 0);
});
