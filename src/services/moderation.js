import OpenAI from 'openai';
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

export async function moderateInput(text) {
  if (process.env.MODERATION_ENABLED !== 'true') return { flagged: false };
  try {
    const response = await openai.moderations.create({ input: text });
    const result = response.results[0];
    return { flagged: result.flagged, categories: result.categories, scores: result.category_scores };
  } catch {
    return { flagged: false };
  }
}