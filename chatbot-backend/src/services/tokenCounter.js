import { encoding_for_model } from 'tiktoken';
import { getModelPricing } from './modelPricing.js';

export function countTokens(text, model = 'gpt-4o-mini') {
  try {
    const encoder = encoding_for_model(model);
    const tokens = encoder.encode(text);
    encoder.free();
    return tokens.length;
  } catch (error) {
    console.warn(`Token encoding fallback for model: ${model}`);
    return Math.ceil(text.length / 4);
  }
}

export function estimateCost(model, inputTokens, outputTokens) {
  const pricing = getModelPricing(model);
  const cost = (inputTokens / 1_000_000) * pricing.input + (outputTokens / 1_000_000) * pricing.output;
  return Number(cost.toFixed(6));
}