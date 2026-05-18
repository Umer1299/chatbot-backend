import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import { redisClient } from './redis.js';

let anthropicClient = null;
let openAIClient = null;

const SCRAPE_ANTHROPIC_ALLOWLIST = new Set([
  'claude-haiku-4-5-20251001',
  'claude-sonnet-4-5-20250929',
]);

const SCRAPE_OPENAI_ALLOWLIST = new Set(['gpt-5-mini']);

function getAnthropicClient() {
  if (anthropicClient) return anthropicClient;
  if (!process.env.ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY is not configured');
  anthropicClient = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  return anthropicClient;
}

function getOpenAIClient() {
  if (openAIClient) return openAIClient;
  if (!process.env.OPENAI_API_KEY) throw new Error('OPENAI_API_KEY is not configured');
  openAIClient = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  return openAIClient;
}

function getScrapeLLMConfig() {
  const provider = (process.env.SCRAPE_LLM_PROVIDER || 'anthropic').toLowerCase();

  if (provider === 'openai') {
    const configuredModel = process.env.SCRAPE_OPENAI_MODEL || 'gpt-5-mini';
    const model = SCRAPE_OPENAI_ALLOWLIST.has(configuredModel) ? configuredModel : 'gpt-5-mini';
    return { provider: 'openai', model, configuredModel, allowlisted: SCRAPE_OPENAI_ALLOWLIST.has(configuredModel) };
  }

  const configuredModel = process.env.SCRAPE_ANTHROPIC_MODEL || 'claude-haiku-4-5-20251001';
  const model = SCRAPE_ANTHROPIC_ALLOWLIST.has(configuredModel)
    ? configuredModel
    : 'claude-haiku-4-5-20251001';

  return {
    provider: 'anthropic',
    model,
    configuredModel,
    allowlisted: SCRAPE_ANTHROPIC_ALLOWLIST.has(configuredModel),
  };
}

export async function scrapeLLM(systemPrompt, messages, options = {}) {
  const cfg = getScrapeLLMConfig();
  console.log('[ai:scrape] Running scrape LLM', {
    provider: cfg.provider,
    model: cfg.model,
    configuredModel: cfg.configuredModel,
    allowlisted: cfg.allowlisted,
  });

  try {
    if (cfg.provider === 'openai') {
      const openai = getOpenAIClient();
      const response = await openai.chat.completions.create({
        model: cfg.model,
        max_tokens: options.maxTokens || 1000,
        messages: [
          { role: 'system', content: systemPrompt },
          ...messages,
        ],
      });
      return response?.choices?.[0]?.message?.content || '';
    }

    const anthropic = getAnthropicClient();
    const response = await anthropic.messages.create({
      model: cfg.model,
      max_tokens: options.maxTokens || 1000,
      system: systemPrompt,
      messages,
    });
    return response?.content?.[0]?.text || '';
  } catch (error) {
    console.error('scrapeLLM error:', error.message);
    throw new Error('Scrape AI request failed. Please try again.');
  }
}

export async function chatbotLLM(systemPrompt, messages, options = {}) {
  const model = process.env.DEFAULT_CHAT_MODEL || process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-5-20250929';
  console.log('[ai:chat] Running chatbot LLM', { model });

  try {
    const anthropic = getAnthropicClient();
    const response = await anthropic.messages.create({
      model,
      max_tokens: options.maxTokens || 1000,
      system: systemPrompt,
      messages,
    });

    return response?.content?.[0]?.text || '';
  } catch (error) {
    console.error('chatbotLLM error:', error.message);
    throw new Error('Chatbot AI request failed. Please try again.');
  }
}

export const claudeChat = chatbotLLM;

export function claudeStream(systemPrompt, messages) {
  const anthropic = getAnthropicClient();
  const model = process.env.DEFAULT_CHAT_MODEL || process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-5-20250929';

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
      model: process.env.EMBEDDING_MODEL || 'text-embedding-ada-002',
      input,
    });

    return result?.data?.[0]?.embedding || null;
  } catch (error) {
    const isQuotaError = error?.status === 429 || error?.code === 'insufficient_quota' || /quota|429/i.test(error?.message || '');
    if (isQuotaError && redisClient) {
      try {
        await redisClient.setex('embeddings:provider_unavailable', 180, '1');
      } catch (_error) {
        // best effort cache only
      }
    }
    if (isQuotaError) {
      console.error('[rag] OpenAI embeddings quota/rate-limit error (non-fatal):', error.message);
    } else {
      console.error('Embedding generation error:', error.message);
    }
    return null;
  }
}
