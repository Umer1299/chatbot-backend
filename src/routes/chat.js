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

async function getLastMessages(namespace, sessionId, limit = 5) {
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
  const {
    botId,
    userId,
    sessionId,
    message,
    model: requestedModel,
    systemPrompt
  } = req.body;
  const namespace = botId || req.namespace;
  const isStreaming = req.query.stream === 'true';
  const writeSse = (payload) => {
    if (!res.writableEnded) {
      res.write(`data: ${typeof payload === 'string' ? payload : JSON.stringify(payload)}\n\n`);
    }
  };
  const writeSseError = (message) => {
    const safeMessage = sanitizeErrorMessage(message);
    if (!res.writableEnded) {
      res.write('event: error\n');
      res.write(`data: ${JSON.stringify({ type: 'error', message: safeMessage })}\n\n`);
    }
  };
  const cleanupStreamingResources = () => {
    clearInterval(keepAlive);
    clearTimeout(timeoutId);
  };
  const sanitizeErrorMessage = (message) => {
    const text = String(message || 'Unexpected error');
    if (/api[_ -]?key|token|pinecone|redis|openai|password|secret/i.test(text)) {
      return 'Internal server error';
    }
    return text;
  };

  if (!botId || !sessionId || !message) {
    return res.status(400).json({ error: 'Missing botId, sessionId, or message' });
  }

  if (botId !== req.namespace) {
    return res.status(403).json({ error: 'botId does not match token scope' });
  }

  if (typeof message !== 'string' || message.trim().length === 0) {
    return res.status(400).json({ error: 'Message cannot be empty' });
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
  let clientDisconnected = false;
  let streamedTokenCount = 0;

  if (isStreaming) {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders?.();
    writeSse({ type: 'ready', sessionId, userId: userId || null });

    keepAlive = setInterval(() => {
      if (!res.writableEnded) res.write(':\n\n');
    }, 15000);

    timeoutId = setTimeout(() => {
      if (!res.writableEnded) {
        writeSseError('Timeout');
        res.end();
      }
      cleanupStreamingResources();
    }, 30000);
  }

  req.on('close', () => {
    clientDisconnected = true;
    cleanupStreamingResources();
  });

  async function runModel(modelName) {
    if (clientDisconnected) throw new Error('Client disconnected');

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

    let systemWithContext = `${finalPrompt}\n\nRelevant context:\n${context}`;
    let input = `System:${systemWithContext}\nUser:${message}`;
    let tokens = countTokens(input, modelName);

    while (tokens > 600 && context.length > 200) {
      context = context.slice(0, context.length * 0.8);
      systemWithContext = `${finalPrompt}\n\nRelevant context:\n${context}`;
      input = `System:${systemWithContext}\nUser:${message}`;
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
                writeSse({ text: token, token });
                streamedTokenCount += 1;
              }
            }
          }]
        : undefined
    });

    const t3 = Date.now();
    const response = await model.invoke([
      { role: 'system', content: systemWithContext },
      ...history,
      { role: 'user', content: message }
    ]);
    console.log(`OpenAI invoke: ${Date.now() - t3} ms`);

    if (!isStreaming || !fullResponse) {
      fullResponse = typeof response.content === 'string'
        ? response.content
        : Array.isArray(response.content)
          ? response.content.map(part => part.text || '').join('')
          : '';
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
    if (clientDisconnected) return;

    try {
      result = await runModel(activeModel);
    } catch (primaryError) {
      if (
        !isStreaming &&
        process.env.FALLBACK_MODEL &&
        process.env.FALLBACK_MODEL !== activeModel
      ) {
        result = await runModel(process.env.FALLBACK_MODEL);
      } else {
        throw primaryError;
      }
    }

    if (isStreaming) {
      if (!res.writableEnded) {
        console.log('[stream-chat] streamedTokenCount', streamedTokenCount);
        if (streamedTokenCount === 0 && result.reply) {
          console.log('[stream-chat] sending final reply fallback', { length: result.reply.length });
          writeSse({ text: result.reply });
        }
        writeSse({ type: 'meta', ...result });
        writeSse('[DONE]');
        res.end();
      }
      cleanupStreamingResources();
    } else {
      res.json(result);
    }

  } catch (err) {
    if (isStreaming) {
      if (!res.writableEnded) {
        writeSseError(err.message || 'Unexpected error');
        res.end();
      }
      cleanupStreamingResources();
    } else {
      res.status(500).json({ error: sanitizeErrorMessage(err.message) });
    }
  }
});

export default router;
