import express from 'express';
import { redisClient } from '../services/redis.js';
import { requireAdminKey } from '../middleware/adminAuth.js';
import { v4 as uuidv4 } from 'uuid';
import { deleteChatbotData } from '../services/chatbotDeletion.js';

const router = express.Router();

// All routes require admin key
router.use(requireAdminKey);

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

router.delete('/:namespace', async (req, res) => {
  try {
    const result = await deleteChatbotData(req.params.namespace);
    res.json({ success: true, ...result });
  } catch (error) {
    console.error('chatbot_delete_failed', { namespace: req.params.namespace, error: error.message });
    res.status(500).json({ error: 'Failed to delete chatbot data' });
  }
});

export default router;
