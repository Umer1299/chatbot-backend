import { z } from "zod";
const status = z.enum(["draft", "active", "paused", "archived"]);
const fields = {
  name: z.string().trim().min(1).max(200),
  description: z.string().max(4000),
  purpose: z.enum([
    "general",
    "lead_generation",
    "customer_support",
    "receptionist",
    "appointment_booking",
    "sales",
  ]),
  status,
};
export const agentCreate = z
  .object(fields)
  .partial()
  .required({ name: true })
  .strict();
export const agentPatch = z
  .object(fields)
  .partial()
  .strict()
  .refine((v) => Object.keys(v).length > 0);
export const configInput = z
  .object({
    expected_version: z.number().int().min(1).max(2147483646),
    status: z.enum(["draft", "active"]),
    system_prompt: z.string().max(32000),
    welcome_message: z.string().max(4000),
    starter_prompts: z.array(z.string().trim().min(1).max(500)).max(10),
    provider: z.enum(["openai", "anthropic"]).nullable(),
    model_id: z.string().min(1).max(200).nullable(),
    temperature: z.number().finite().min(0).max(2),
    generation_settings: z
      .object({
        max_output_tokens: z.number().int().min(1).max(8192).optional(),
        top_p: z.number().min(0).max(1).optional(),
      })
      .strict(),
    // Only capabilities already supported by the backend. These select behavior, never authorize it.
    capabilities: z
      .array(z.enum(["lead_capture", "human_escalation"]))
      .max(2)
      .refine((v) => new Set(v).size === v.length),
    lead_capture: z
      .object({
        enabled: z.boolean(),
        fields: z
          .array(z.enum(["name", "email", "phone"]))
          .max(3)
          .refine((v) => new Set(v).size === v.length),
      })
      .strict(),
    escalation: z
      .object({
        enabled: z.boolean(),
        message: z.string().max(2000).optional(),
      })
      .strict(),
  })
  .strict()
  .superRefine((v, ctx) => {
    if (v.provider === "anthropic" && v.temperature > 1)
      ctx.addIssue({ code: "custom", message: "Unsupported temperature" });
    if (
      (v.model_id === null) !== (v.provider === null) ||
      (v.status === "active" && (!v.model_id || !v.system_prompt.trim()))
    )
      ctx.addIssue({
        code: "custom",
        message: "Active configuration needs a model and system prompt",
      });
  });
export function validate(schema, body) {
  const parsed = schema.safeParse(body);
  if (!parsed.success)
    throw Object.assign(new Error("Invalid request"), { status: 400 });
  return parsed.data;
}
