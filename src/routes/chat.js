import express from 'express';
import { ChatOpenAI } from '@langchain/openai';
import { redisClient } from '../services/redis.js';
import { getRetriever } from '../services/pinecone.js';
import { countTokens, estimateCost } from '../services/tokenCounter.js';
import { moderateInput } from '../services/moderation.js';
import { detectLead } from '../services/leadDetection.js';
import { leadCaptureTool } from '../tools/leadCaptureTool.js';
import { tokenAuth } from '../middleware/tokenAuth.js';
import { domainRestriction } from '../middleware/domainRestriction.js';
import { ALLOWED_MODELS, getModelCreditCost } from '../services/modelPricing.js';

const router = express.Router();

async function getLastMessages(namespace, sessionId, limit = 10) {
  const key = `chat_history:${namespace}:${sessionId}`;
  const history = await redisClient.lrange(key, -limit, -1);
  return history.map(msg => JSON.parse(msg));
}

async function addMessage(namespace, sessionId, role, content) {
  const key = `chat_history:${namespace}:${sessionId}`;
  const msg = JSON.stringify({ role, content, timestamp: Date.now() });
  await redisClient.rpush(key, msg);
  await redisClient.ltrim(key, -20, -1);
  await redisClient.expire(key, 3600);
}

router.post('/', tokenAuth, domainRestriction, async (req, res) => {
  const { sessionId, message, model: requestedModel, systemPrompt } = req.body;
  const namespace = req.namespace;
  const isStreaming = req.query.stream === 'true';

  if (!sessionId || !message) {
    return res.status(400).json({ error: 'Missing sessionId or message' });
  }

  const settingsRaw = await redisClient.get(`chatbot:${namespace}`);
  const settings = settingsRaw ? JSON.parse(settingsRaw) : {};

  const activeModel = requestedModel || settings.model || process.env.DEFAULT_MODEL;

  if (!ALLOWED_MODELS.has(activeModel)) {
    return res.status(400).json({ error: 'Invalid model' });
  }

  const finalPrompt = systemPrompt || settings.systemPrompt || 'You are a helpful assistant.';

  const moderation = await moderateInput(message);
  if (moderation.flagged) {
    return res.status(400).json({ error: 'Message violates policy' });
  }

  if (countTokens(message, activeModel) > 600) {
    return res.status(400).json({ error: 'Message too long (600 token limit)' });
  }

  let keepAlive, timeoutId;

  if (isStreaming) {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders?.();

    keepAlive = setInterval(() => {
      if (!res.writableEnded) res.write(':\n\n');
    }, 15000);

    timeoutId = setTimeout(() => {
      if (!res.writableEnded) {
        res.write(`data: ${JSON.stringify({ type: 'error', message: 'Timeout' })}\n\n`);
        res.end();
      }
      clearInterval(keepAlive);
    }, 30000);
  }

  async function runModel(modelName) {
    const t1 = Date.now();
    const history = await getLastMessages(namespace, sessionId);
    console.log(`History fetch: ${Date.now() - t1} ms`);

    // Cache key using namespace + first 100 chars of message
    const cacheKey = `rag:${namespace}:${message.slice(0, 100)}`;
    let ragDocs;
    const t2 = Date.now();
    const cached = await redisClient.get(cacheKey);
    if (cached) {
      ragDocs = JSON.parse(cached);
      console.log(`Pinecone cache hit: ${Date.now() - t2} ms`);
    } else {
      const retriever = await getRetriever(namespace, 4);
      ragDocs = await retriever.getRelevantDocuments(message);
      await redisClient.setex(cacheKey, 300, JSON.stringify(ragDocs));
      console.log(`Pinecone retrieval (cache miss): ${Date.now() - t2} ms`);
    }

    let context = ragDocs.map(d => d.pageContent).join('\n');

    let input = `System:${finalPrompt}\nContext:${context}\nUser:${message}`;
    let tokens = countTokens(input, modelName);

    while (tokens > 600 && context.length > 200) {
      context = context.slice(0, context.length * 0.8);
      input = `System:${finalPrompt}\nContext:${context}\nUser:${message}`;
      tokens = countTokens(input, modelName);
    }

    if (tokens > 600) throw new Error('Context too large');

    let fullResponse = '';
    const model = new ChatOpenAI({
      modelName,
      temperature: 0.2,
      maxTokens: 600,
      streaming: isStreaming,
      callbacks: isStreaming
        ? [{
            handleLLMNewToken(token) {
              fullResponse += token;
              if (!res.writableEnded) {
                res.write(`data: ${JSON.stringify({ token })}\n\n`);
              }
            }
          }]
        : undefined
    });

    const t3 = Date.now();
    const response = await model.invoke([
      { role: 'system', content: finalPrompt },
      ...history,
      { role: 'user', content: message }
    ]);
    console.log(`OpenAI invoke: ${Date.now() - t3} ms`);

    if (!isStreaming || !fullResponse) {
      fullResponse = response.content || '';
    }

    await addMessage(namespace, sessionId, 'user', message);
    await addMessage(namespace, sessionId, 'assistant', fullResponse);

    const outputTokens = countTokens(fullResponse, modelName);

    await redisClient.incrbyfloat(
      `cost_usd:${namespace}`,
      estimateCost(modelName, tokens, outputTokens)
    );

    const lead = detectLead(message);
    if (lead.isLead) {
      const exists = await redisClient.get(`lead:${namespace}:${sessionId}`);
      if (!exists) {
        await leadCaptureTool.func({ ...lead.contactInfo, message, score: lead.score });
        await redisClient.setex(`lead:${namespace}:${sessionId}`, 86400, '1');
      }
    }

    return {
      reply: fullResponse,
      creditsUsed: getModelCreditCost(modelName),
      inputTokens: tokens,
      outputTokens,
      model: modelName
    };
  }

  try {
    let result;
    try {
      result = await runModel(activeModel);
    } catch {
      if (process.env.FALLBACK_MODEL && process.env.FALLBACK_MODEL !== activeModel) {
        result = await runModel(process.env.FALLBACK_MODEL);
      } else {
        throw new Error('Model failed');
      }
    }

    if (isStreaming) {
      if (!res.writableEnded) {
        res.write(`data: ${JSON.stringify({ type: 'meta', ...result })}\n\n`);
        res.write('data: [DONE]\n\n');
        res.end();
      }
      clearInterval(keepAlive);
      clearTimeout(timeoutId);
    } else {
      res.json(result);
    }

  } catch (err) {
    if (isStreaming) {
      if (!res.writableEnded) {
        res.write(`data: ${JSON.stringify({ type: 'error', message: err.message })}\n\n`);
        res.end();
      }
      clearInterval(keepAlive);
      clearTimeout(timeoutId);
    } else {
      res.status(500).json({ error: err.message });
    }
  }
});

export default router;