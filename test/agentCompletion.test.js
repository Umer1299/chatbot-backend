import { test, mock } from "node:test";
import assert from "node:assert/strict";

const requests = [];
mock.module("openai", {
  defaultExport: class {
    chat = {
      completions: {
        create: async (request) => {
          requests.push(["openai", request]);
          return { choices: [{ message: { content: "OpenAI reply" } }], usage: { prompt_tokens: 20, completion_tokens: 5 } };
        },
      },
    };
  },
});
mock.module("@anthropic-ai/sdk", {
  defaultExport: class {
    messages = {
      create: async (request) => {
        requests.push(["anthropic", request]);
        return { content: [{ type: "text", text: "Anthropic reply" }], usage: { input_tokens: 30, output_tokens: 6 } };
      },
    };
  },
});
const { completeAgent } = await import("../src/services/agentCompletion.js");

test("configured top_p reaches both providers without changing defaults", async () => {
  const oldOpenAI = process.env.OPENAI_API_KEY;
  const oldAnthropic = process.env.ANTHROPIC_API_KEY;
  process.env.OPENAI_API_KEY = "test-only";
  process.env.ANTHROPIC_API_KEY = "test-only";
  try {
    for (const provider of ["openai", "anthropic"]) {
      const base = {
        provider,
        apiModelId: "mock-model",
        systemPrompt: "Test assistant",
        messages: [{ role: "user", content: "Hello" }],
      };
      const response = await completeAgent({ ...base, settings: { top_p: 0.31 } });
      assert.equal(requests.at(-1)[0], provider);
      assert.equal(requests.at(-1)[1].top_p, 0.31);
      assert.equal(response.rawUsage[provider === "openai" ? "prompt_tokens" : "input_tokens"], provider === "openai" ? 20 : 30);
      await completeAgent({ ...base, settings: {} });
      assert.equal(Object.hasOwn(requests.at(-1)[1], "top_p"), false);
    }
  } finally {
    if (oldOpenAI === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = oldOpenAI;
    if (oldAnthropic === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = oldAnthropic;
  }
});
