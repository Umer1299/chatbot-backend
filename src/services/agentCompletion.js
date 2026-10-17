import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
// A small provider adapter. Routing, knowledge, tenancy and persistence live outside it.
export async function completeAgent({
  provider,
  apiModelId,
  systemPrompt,
  messages,
  settings = {},
}) {
  const max_tokens = settings.max_output_tokens ?? 1000;
  if (provider === "openai") {
    if (!process.env.OPENAI_API_KEY) throw new Error("OpenAI unavailable");
    const answer = await new OpenAI({
      apiKey: process.env.OPENAI_API_KEY,
    }).chat.completions.create({
      model: apiModelId,
      max_tokens,
      temperature: settings.temperature ?? 0.7,
      ...(settings.top_p === undefined ? {} : { top_p: settings.top_p }),
      messages: [{ role: "system", content: systemPrompt }, ...messages],
    });
    return answer.choices[0].message.content;
  }
  if (provider === "anthropic") {
    if (!process.env.ANTHROPIC_API_KEY)
      throw new Error("Anthropic unavailable");
    const answer = await new Anthropic({
      apiKey: process.env.ANTHROPIC_API_KEY,
    }).messages.create({
      model: apiModelId,
      max_tokens,
      temperature: Math.min(1, settings.temperature ?? 0.7),
      ...(settings.top_p === undefined ? {} : { top_p: settings.top_p }),
      system: systemPrompt,
      messages,
    });
    return answer.content.find((c) => c.type === "text")?.text || "";
  }
  throw new Error("Unsupported provider");
}
