import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import { redisClient } from './redis.js';
import { getOpenAITokenLimitParam } from './openaiTokenLimitParam.js';

let anthropicClient = null;
let openAIClient = null;

const SCRAPE_ANTHROPIC_ALLOWLIST = new Set([
  'claude-haiku-4-5-20251001',
  'claude-sonnet-4-5-20250929',
]);

const SCRAPE_OPENAI_ALLOWLIST = new Set(['gpt-5-mini']);

function isGPT5Model(modelId) {
  return String(modelId || '').toLowerCase().startsWith('gpt-5');
}


function extractResponsesText(response) {
  const direct = typeof response?.output_text === 'string' ? response.output_text.trim() : '';
  if (direct) return direct;

  const parts = [];
  for (const item of response?.output || []) {
    for (const content of item?.content || []) {
      if (typeof content?.text === 'string') parts.push(content.text);
      if (typeof content?.output_text === 'string') parts.push(content.output_text);
      if (content?.type === 'output_text' && typeof content?.text === 'string') parts.push(content.text);
    }
  }

  return parts.join('').trim();
}

function logOpenAIResponsesDebug(response, meta = {}) {
  if (process.env.NODE_ENV === 'production') return;
  console.log('openai_response_shape_debug', {
    ...meta,
    status: response?.status,
    outputLength: response?.output?.length,
    outputTypes: response?.output?.map((o) => o?.type),
    contentTypes: response?.output?.flatMap((o) => (o?.content || []).map((c) => c?.type)),
    outputTextLength: response?.output_text?.length,
    usage: response?.usage
  });
}

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
      const apiPath = isGPT5Model(cfg.model) ? 'responses' : 'chat_completions';
      console.log('openai_api_path_debug', { modelId: cfg.model, apiModelId: cfg.model, apiPath });
      if (isGPT5Model(cfg.model)) {
        const response = await openai.responses.create({
          model: cfg.model,
          input: [
            { role: 'system', content: systemPrompt },
            ...messages.map((m) => ({ role: m.role, content: String(m.content || '') })),
          ],
          max_output_tokens: Math.max(options.maxTokens || 1000, 700),
          reasoning: { effort: 'low' },
          text: { verbosity: 'low' }
        });
        logOpenAIResponsesDebug(response, { modelId: cfg.model, apiModelId: cfg.model, apiPath: 'responses' });
        if (response?.status === 'incomplete') {
          console.warn('openai_response_incomplete', { reason: response?.incomplete_details?.reason });
        }
        const reply = extractResponsesText(response);
        if (!reply) {
          console.warn('openai_empty_reply_debug', {
            modelId: cfg.model,
            apiModelId: cfg.model,
            apiUsed: 'responses',
            status: response.status,
            outputLength: response.output?.length,
            outputTypes: response.output?.map((o) => o.type),
            usage: response.usage
          });
        }
        return reply || 'I’m sorry, I couldn’t generate a response just now. Could you please try again?';
      }
      const { tokenParamName, tokenParam } = getOpenAITokenLimitParam(cfg.model, options.maxTokens || 1000);
      console.log('openai_token_param_debug', { modelId: cfg.model, apiModelId: cfg.model, tokenParamName });
      const response = await openai.chat.completions.create({
        model: cfg.model,
        ...tokenParam,
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
