import { test } from "node:test";
import assert from "node:assert/strict";
import {
  agentCreate,
  agentPatch,
  configInput,
  validate,
} from "../src/services/agentValidation.js";
const config = {
  expected_version: 1,
  status: "draft",
  system_prompt: "",
  welcome_message: "",
  starter_prompts: [],
  provider: null,
  model_id: null,
  temperature: 0.7,
  generation_settings: {},
  capabilities: [],
  lead_capture: { enabled: false, fields: [] },
  escalation: { enabled: false },
};
test("agent metadata rejects ownership, public IDs and authorization mass assignment", () => {
  for (const field of [
    "business_id",
    "id",
    "public_id",
    "agency_role",
    "created_at",
  ])
    assert.throws(
      () => validate(agentCreate, { name: "Agent", [field]: "forged" }),
      { status: 400 },
    );
  assert.equal(validate(agentCreate, { name: "  Support  " }).name, "Support");
  assert.throws(() => validate(agentPatch, {}), { status: 400 });
});
test("agent metadata accepts only bounded supported lifecycle and purpose", () => {
  for (const body of [
    { name: "" },
    { name: "x".repeat(201) },
    { status: "deleted" },
    { purpose: "admin" },
  ])
    assert.throws(() => validate(agentPatch, body), { status: 400 });
  assert.deepEqual(validate(agentPatch, { status: "archived" }), {
    status: "archived",
  });
});
test("empty draft config is legitimate; active config requires model and prompt", () => {
  assert.deepEqual(validate(configInput, config), config);
  assert.throws(() => validate(configInput, { ...config, status: "active" }), {
    status: 400,
  });
  assert.throws(
    () => validate(configInput, { ...config, provider: "openai" }),
    { status: 400 },
  );
});
test("config rejects credentials, arbitrary tools, external references and authorization claims", () => {
  for (const body of [
    { api_key: "secret" },
    { credentials: {} },
    { agent_id: "foreign" },
    { role: "owner" },
    { capabilities: ["run_shell"] },
    { escalation: { enabled: true, url: "https://attacker.test" } },
    { lead_capture: { enabled: true, fields: ["password"] } },
  ])
    assert.throws(() => validate(configInput, { ...config, ...body }), {
      status: 400,
    });
});
test("configuration requires explicit bounded optimistic version", () => {
  for (const expected_version of [undefined, 0, -1, 1.2, 2147483647, "1"])
    assert.throws(
      () => validate(configInput, { ...config, expected_version }),
      { status: 400 },
    );
});
test("generation settings reject unsupported values, provider limits and duplicate capabilities", () => {
  for (const body of [
    { temperature: Infinity },
    { temperature: 2.1 },
    { provider: "anthropic", model_id: "claude-sonnet", temperature: 1.1 },
    { generation_settings: { max_output_tokens: 8193 } },
    { generation_settings: { top_p: 1.1 } },
    { generation_settings: { seed: 1 } },
    { capabilities: ["lead_capture", "lead_capture"] },
  ])
    assert.throws(() => validate(configInput, { ...config, ...body }), {
      status: 400,
    });
});
