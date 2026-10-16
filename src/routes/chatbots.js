import { asyncHandler } from '../middleware/asyncHandler.js';
import { getChatbotSettings, saveChatbotSettings, listChatbotSettings, deleteChatbotSettings } from '../services/chatbotSettings.js';
import express from 'express';
import { redisClient } from '../services/redis.js';
import { requireAdminKey } from '../middleware/adminAuth.js';
import { v4 as uuidv4 } from 'uuid';
import { deleteBusinessChunks } from '../db/vectorStore.js';
import pool from '../db/pool.js';

const router = express.Router();

// All routes require admin key
router.use(requireAdminKey);

router.get('/:namespace', asyncHandler(async (req, res) => {
  try { return res.json(await getChatbotSettings(req.params.namespace)); }
  catch (error) {
    if (error.code === 'BOT_SETTINGS_MISSING') return res.status(404).json({ error: 'Not found' });
    throw error;
  }
}));

router.post('/:namespace', asyncHandler(async (req, res) => {
  const { namespace } = req.params;
  const { model = process.env.DEFAULT_MODEL, systemPrompt = 'You are a helpful assistant.' } = req.body;
  let allowedDomains = req.body.allowedDomains;
  if (!Object.hasOwn(req.body, 'allowedDomains')) {
    try { allowedDomains = (await getChatbotSettings(namespace)).allowedDomains; }
    catch (error) {
      if (error.code === 'BOT_SETTINGS_MISSING') {
        return res.status(400).json({ error: 'allowedDomains is required for new bot settings (use [] for unrestricted access)' });
      }
      throw error;
    }
  }
  const settings = { model, systemPrompt, allowedDomains, updatedAt: new Date().toISOString() };
  try {
    await saveChatbotSettings(namespace, settings);
  } catch (error) {
    if (error.code === 'INVALID_BOT_SETTINGS') return res.status(400).json({ error: 'allowedDomains must be an array of nonempty strings' });
    throw error;
  }

  let token = await redisClient.get(`chatbot_namespace_token:${namespace}`);
  if (!token) {
    token = uuidv4();
    await redisClient.setex(`chatbot_token:${token}`, 86400 * 365, namespace);
    await redisClient.setex(`chatbot_namespace_token:${namespace}`, 86400 * 365, token);
  }
  res.json({ success: true, namespace, settings, token });
}));

router.get('/', asyncHandler(async (req, res) => {
  res.json(await listChatbotSettings());
}));

router.delete('/:namespace', asyncHandler(async (req, res) => {
  const { namespace } = req.params;
  const token = await redisClient.get(`chatbot_namespace_token:${namespace}`);
  if (token) await redisClient.del(`chatbot_token:${token}`);
  await redisClient.del(`chatbot_namespace_token:${namespace}`);
  await deleteChatbotSettings(namespace);

  // Remove knowledge base chunks from pgvector
  const bizResult = await pool.query(
    'SELECT id FROM businesses WHERE bot_id = $1',
    [namespace]
  );
  if (bizResult.rows.length) {
    await deleteBusinessChunks(bizResult.rows[0].id);
  }

  res.json({ success: true });
}));

export default router;
