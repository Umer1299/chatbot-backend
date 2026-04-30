import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

export async function claudeChat(systemPrompt, messages, options = {}) {
  try {
    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-5',
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
  return anthropic.messages.stream({
    model: 'claude-sonnet-4-5',
    max_tokens: 1000,
    system: systemPrompt,
    messages,
  });
}

export async function getEmbedding(text) {
  try {
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
