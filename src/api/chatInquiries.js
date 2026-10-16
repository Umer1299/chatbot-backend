import { rememberInquiryOnlySession } from '../services/inquirySessions.js';
import { applyChatEmailPolicy } from '../services/chatConfigPolicy.js';
import { getRecentConversationHistory, buildSessionMemoryBlock } from '../db/sessionHistory.js';
import express from 'express';
import { asyncHandler } from '../middleware/asyncHandler.js';
import pool from '../db/pool.js';
import { requireChatSession } from '../middleware/chatSession.js';
import { removeVisibleInquiryJson, saveInquiryFromConversation } from '../services/inquiryService.js';
import originalRouter from './chatOptimized.js';

import { tokenAuth } from '../middleware/tokenAuth.js';
import { domainRestriction } from '../middleware/domainRestriction.js';

const router = express.Router();
router.use(tokenAuth, domainRestriction, requireChatSession);
function cleanPayload(payload, capture) {
  if (!payload || typeof payload !== 'object') return payload;
  if (typeof payload.reply === 'string') {
    capture.assistantMessage = `${capture.assistantMessage || ''}\n${payload.reply}`.trim();
    payload.reply = removeVisibleInquiryJson(payload.reply);
  }
  if (typeof payload.text === 'string') capture.assistantMessage += payload.text;
  if (typeof payload.token === 'string' && payload.token !== payload.text) capture.assistantMessage += payload.token;
  return payload;
}

function patchResponse(res, capture) {
  const originalJson = res.json.bind(res);
  const originalWrite = res.write.bind(res);

  res.json = (payload) => originalJson(cleanPayload(payload, capture));

  res.write = (chunk, encoding, callback) => {
    const text = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
    if (!text.startsWith('data: ')) return originalWrite(chunk, encoding, callback);

    const jsonText = text.replace(/^data:\s*/, '').trim();
    if (jsonText === '[DONE]') return originalWrite(chunk, encoding, callback);

    try {
      const payload = JSON.parse(jsonText);
      const patched = cleanPayload(payload, capture);
      return originalWrite(`data: ${JSON.stringify(patched)}\n\n`, encoding, callback);
    } catch {
      return originalWrite(chunk, encoding, callback);
    }
  };
}

async function loadConfig(botId) {
  const cfg = await pool.query(
    `SELECT bc.selected_agents, b.industry, b.business_name, b.owner_email, b.owner_phone, b.escalation_email, b.bot_id, b.id as business_id, b.plan, b.is_disabled
     FROM bot_configs bc
     JOIN businesses b ON bc.business_id = b.id
     WHERE b.bot_id=$1 AND bc.active=true
     LIMIT 1`,
    [botId],
  );
  return applyChatEmailPolicy(cfg.rows?.[0] || null);
}

async function saveInquiry(req, capture, config, options = {}) {
  const { botId, sessionId, message } = req.body || {};
  if (!botId || !sessionId || !message || !config?.business_id) return null;

  const [sessionResult, historyResult] = await Promise.all([
    pool.query('SELECT * FROM sessions WHERE id=$1 AND business_id=$2', [sessionId, config.business_id]).catch(() => ({ rows: [] })),
    getRecentConversationHistory(sessionId, config.business_id).then(rows => ({ rows })).catch(() => ({ rows: [] })),
  ]);

  const session = sessionResult.rows?.[0];
  if (!session) return null;
  const memory = buildSessionMemoryBlock(session);
  if (memory) historyResult.rows.unshift({ role: 'user', content: memory });
  return saveInquiryFromConversation({
    session: { ...session, id: sessionId },
    conversationHistory: historyResult.rows || [],
    userMessage: message,
    assistantMessage: capture.assistantMessage || '',
    config,
    namespace: botId,
    ...options,
  });
}

router.use(asyncHandler(async (req, res, next) => {
  const capture = { assistantMessage: '' };
  patchResponse(res, capture);

  let config = null;
  if (req.method === 'POST' && req.body?.botId && req.body?.sessionId && req.body?.message) {
    config = await loadConfig(req.body.botId).catch((error) => {
      console.error('inquiry config load failed:', error.message);
      return null;
    });

    if (config && !config.is_disabled && config.business_id === req.chatSession.business_id) {
      const inquiry = await saveInquiry(req, capture, config, { notify: false }).catch((error) => {
        console.error('pre inquiry save failed:', error.message);
        return null;
      });
      if (inquiry?.id) rememberInquiryOnlySession(config.business_id, req.body.sessionId);
    }
  }

  res.on('finish', () => {
    if (!config || config.is_disabled || config.business_id !== req.chatSession.business_id || res.statusCode >= 400) return;
    saveInquiry(req, capture, config, { notify: true })
      .then((inquiry) => { if (inquiry?.id) rememberInquiryOnlySession(config.business_id, req.body.sessionId); })
      .catch((error) => console.error('post inquiry save failed:', error.message));
  });

  return originalRouter(req, res, next);
}));

export default router;
