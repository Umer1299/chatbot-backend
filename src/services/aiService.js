import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';

let anthropicClient = null;
let openAIClient = null;

function getAnthropicClient() {
  if (anthropicClient) {
    return anthropicClient;
  }

  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error('ANTHROPIC_API_KEY is not configured');
  }

  anthropicClient = new Anthropic({
    apiKey: process.env.ANTHROPIC_API_KEY,
  });

  return anthropicClient;
}

function getOpenAIClient() {
  if (openAIClient) {
    return openAIClient;
  }

  if (!process.env.OPENAI_API_KEY) {
    throw new Error('OPENAI_API_KEY is not configured');
  }

  openAIClient = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
  });

  return openAIClient;
}

export async function claudeChat(systemPrompt, messages, options = {}) {
  try {
    const anthropic = getAnthropicClient();
    const model = process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-5-20250929';

    const response = await anthropic.messages.create({
      model,
      max_tokens: options.maxTokens || 1000,
      system: systemPrompt,
      messages,
    });

    return response?.content?.[0]?.text || '';
  } catch (error) {
    console.error('Claude chat error:', error.message);
    throw new Error('Claude chat request failed. Please try again.');
  }
}

export function claudeStream(systemPrompt, messages) {
  const anthropic = getAnthropicClient();
  const model = process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-5-20250929';

  return anthropic.messages.stream({
    model,
    max_tokens: 1000,
    system: systemPrompt,
    messages,
  });
}

export async function getEmbedding(text) {
  try {
    const openai = getOpenAIClient();
    const input = typeof text === 'string' ? text.slice(0, 8000) : '';

    const result = await openai.embeddings.create({
      model: 'text-embedding-ada-002',
      input,
    });

    return result?.data?.[0]?.embedding || null;
  } catch (error) {
    console.error('Embedding generation error:', error.message);
    return null;
  }
}
