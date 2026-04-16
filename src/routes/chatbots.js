import express from 'express';
import { redisClient } from '../services/redis.js';
import { initPinecone } from '../services/pinecone.js';
import { tokenAuth } from '../middleware/tokenAuth.js';
import { v4 as uuidv4 } from 'uuid';

const router = express.Router();

router.get('/:namespace', async (req, res) => {
  const data = await redisClient.get(`chatbot:${req.params.namespace}`);
  if (!data) return res.status(404).json({ error: 'Not found' });
  res.json(JSON.parse(data));
});

router.post('/:namespace', async (req, res) => {
  const { namespace } = req.params;
  const { model = process.env.DEFAULT_MODEL, systemPrompt = 'You are a helpful assistant.', allowedDomains = [] } = req.body;
  const settings = { model, systemPrompt, allowedDomains, updatedAt: new Date().toISOString() };
  await redisClient.setex(`chatbot:${namespace}`, 86400 * 30, JSON.stringify(settings));

  let token = await redisClient.get(`chatbot_namespace_token:${namespace}`);
  if (!token) {
    token = uuidv4();
    await redisClient.setex(`chatbot_token:${token}`, 86400 * 365, namespace);
    await redisClient.setex(`chatbot_namespace_token:${namespace}`, 86400 * 365, token);
  }
  res.json({ success: true, namespace, settings, token });
});

router.get('/', async (req, res) => {
  const keys = await redisClient.keys('chatbot:*');
  const chatbots = [];
  for (const key of keys) {
    const namespace = key.replace('chatbot:', '');
    const data = await redisClient.get(key);
    chatbots.push({ namespace, settings: JSON.parse(data) });
  }
  res.json(chatbots);
});

router.delete('/:namespace', tokenAuth, async (req, res) => {
  const { namespace } = req.params;
  const token = await redisClient.get(`chatbot_namespace_token:${namespace}`);
  if (token) await redisClient.del(`chatbot_token:${token}`);
  await redisClient.del(`chatbot_namespace_token:${namespace}`);
  await redisClient.del(`chatbot:${namespace}`);
  const { client } = await initPinecone();
  const index = client.Index(process.env.PINECONE_INDEX);
  await index.namespace(namespace).deleteAll();
  res.json({ success: true });
});

export default router;