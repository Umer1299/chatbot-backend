import express from 'express';
import { ChatOpenAI } from '@langchain/openai';
import { redisClient } from '../services/redis.js';
import { getRetriever } from '../services/pinecone.js';
import { creditService } from '../services/creditService.js';
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
  const { sessionId, message, model: requestedModel, systemPrompt: customSystemPrompt } = req.body;
  const namespace = req.namespace;

  if (!sessionId || !message) {
    return res.status(400).json({ error: 'Missing sessionId or message' });
  }

  const settingsRaw = await redisClient.get(`chatbot:${namespace}`);
  const settings = settingsRaw ? JSON.parse(settingsRaw) : {};

  let activeModel = requestedModel || settings.model || process.env.DEFAULT_MODEL;
  if (!ALLOWED_MODELS.has(activeModel)) {
    return res.status(400).json({
      error: `Invalid model. Allowed: ${Array.from(ALLOWED_MODELS).join(', ')}`,
    });
  }

  const finalSystemPrompt = customSystemPrompt || settings.systemPrompt || 'You are a helpful assistant.';

  // Credit cost for this model (per message)
  const creditCost = getModelCreditCost(activeModel);
  const balance = await creditService.getBalance(sessionId);
  if (balance < creditCost) {
    return res.status(402).json({ error: `Insufficient credits. Need ${creditCost}, have ${balance}` });
  }

  console.log(`Chat - namespace: ${namespace}, requested: ${requestedModel || 'not specified'}, used: ${activeModel}, credits: ${creditCost}`);

  const moderation = await moderateInput(message);
  if (moderation.flagged) {
    return res.status(400).json({ error: 'Message violates policy', moderation });
  }

  const userTokens = countTokens(message, activeModel);
  if (userTokens > 600) {
    return res.status(400).json({ error: 'User message exceeds 600 tokens' });
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  let timeoutId = setTimeout(() => {
    res.write(`data: ${JSON.stringify({ type: 'error', message: 'Stream timeout' })}\n\n`);
    res.end();
  }, 30000);

  req.on('close', () => {
    clearTimeout(timeoutId);
    if (!res.writableEnded) res.end();
  });

  let streamingStarted = false;
  let fallbackAttempted = false;

  async function streamWithModel(modelName) {
    return new Promise(async (resolve, reject) => {
      try {
        const lastMessages = await getLastMessages(namespace, sessionId, 10);
        const chatHistory = lastMessages.map(m => ({ role: m.role, content: m.content }));

        const retriever = await getRetriever(namespace, 5);
        const ragDocs = await retriever.getRelevantDocuments(message);
        let ragContext = ragDocs.map(d => d.pageContent).join('\n');

        let fullInput = `System: ${finalSystemPrompt}\nContext: ${ragContext}\nHistory: ${JSON.stringify(chatHistory)}\nUser: ${message}`;
        let totalTokens = countTokens(fullInput, modelName);

        if (totalTokens > 600) {
          let truncated = false;
          while (totalTokens > 600 && ragContext.length > 200) {
            ragContext = ragContext.slice(0, Math.floor(ragContext.length * 0.8));
            fullInput = `System: ${finalSystemPrompt}\nContext: ${ragContext}\nHistory: ${JSON.stringify(chatHistory)}\nUser: ${message}`;
            totalTokens = countTokens(fullInput, modelName);
            truncated = true;
          }
          if (totalTokens > 600) {
            reject(new Error(`Input context too large (${totalTokens} tokens). Max 600 allowed.`));
            return;
          }
          if (truncated) console.log(`RAG context truncated to fit 600 token limit`);
        }

        const inputTokens = totalTokens;
        const estimatedOutputTokens = 600;

        const messages = [
          { role: 'system', content: finalSystemPrompt },
          ...chatHistory,
          { role: 'user', content: message },
        ];

        let fullResponse = '';
        const modelInstance = new ChatOpenAI({
          modelName: modelName,
          temperature: 0.2,
          maxTokens: 600,
          streaming: true,
          callbacks: [{
            handleLLMNewToken(token) {
              if (!streamingStarted) streamingStarted = true;
              fullResponse += token;
              res.write(`data: ${JSON.stringify({ token })}\n\n`);
            }
          }],
        });

        const response = await modelInstance.invoke(messages);
        await addMessage(namespace, sessionId, 'user', message);
        await addMessage(namespace, sessionId, 'assistant', fullResponse);

        // Deduct credits (fixed cost per message)
        await creditService.deductCredits(sessionId, creditCost);
        await creditService.logTransaction(sessionId, creditCost, 'usage', { model: modelName, namespace, tokens: countTokens(fullResponse, modelName) });

        // Optional: track cost in USD for analytics (not used for billing)
        const actualCostUSD = estimateCost(modelName, inputTokens, countTokens(fullResponse, modelName));
        const costKey = `cost_usd:${namespace}`;
        await redisClient.incrbyfloat(costKey, actualCostUSD);
        await redisClient.expire(costKey, 86400 * 30);

        const lead = detectLead(message);
        if (lead.isLead) {
          const alreadyCaptured = await redisClient.get(`lead_captured:${namespace}:${sessionId}`);
          if (!alreadyCaptured) {
            await leadCaptureTool.func({
              name: lead.contactInfo.name,
              email: lead.contactInfo.email,
              phone: lead.contactInfo.phone,
              message: message,
              score: lead.score,
            });
            await redisClient.setex(`lead_captured:${namespace}:${sessionId}`, 86400, '1');
            console.log(`Lead captured: ${namespace}:${sessionId}, score ${lead.score}`);
          }
        }

        console.log(`Chat - namespace: ${namespace}, model: ${modelName}, credits: ${creditCost}, tokens: ${inputTokens}+${fullResponse.length}`);
        resolve(fullResponse);
      } catch (err) {
        reject(err);
      }
    });
  }

  try {
    await streamWithModel(activeModel);
    clearTimeout(timeoutId);
    res.write('data: [DONE]\n\n');
    res.end();
  } catch (error) {
    if (streamingStarted) {
      console.error('Streaming failed after first token:', error);
      clearTimeout(timeoutId);
      if (!res.writableEnded) {
        res.write(`data: ${JSON.stringify({ type: 'error', message: error.message })}\n\n`);
        res.end();
      }
      return;
    }

    if (!fallbackAttempted && process.env.FALLBACK_MODEL && process.env.FALLBACK_MODEL !== activeModel) {
      console.warn(`Fallback triggered: ${activeModel} → ${process.env.FALLBACK_MODEL}`);
      fallbackAttempted = true;
      try {
        await streamWithModel(process.env.FALLBACK_MODEL);
        clearTimeout(timeoutId);
        res.write('data: [DONE]\n\n');
        res.end();
      } catch (fallbackError) {
        console.error('Fallback also failed:', fallbackError);
        clearTimeout(timeoutId);
        if (!res.writableEnded) {
          res.write(`data: ${JSON.stringify({ type: 'error', message: fallbackError.message })}\n\n`);
          res.end();
        }
      }
    } else {
      console.error('Chat error (no fallback):', error);
      clearTimeout(timeoutId);
      if (!res.writableEnded) {
        res.write(`data: ${JSON.stringify({ type: 'error', message: error.message })}\n\n`);
        res.end();
      }
    }
  }
});

export default router;