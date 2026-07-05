import express from 'express';
import { tokenAuth } from '../middleware/tokenAuth.js';
import { domainRestriction } from '../middleware/domainRestriction.js';

const router = express.Router();

function isTestVersion(value) {
  return /^(test|version-test|dev|development|true|1|yes)$/i.test(String(value || '').trim());
}

function getBubbleApiHost(version) {
  const fallback = 'https://chatflowai.io';
  const rawHost = process.env.BUBBLE_API_URL || process.env.BUBBLE_APP_URL || fallback;
  const host = String(rawHost || fallback).replace(/\/+$/, '');
  if (isTestVersion(version)) return /\/version-test$/i.test(host) ? host : `${host}/version-test`;
  return host.replace(/\/version-test$/i, '');
}

function normalizeNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

router.post('/', tokenAuth, domainRestriction, async (req, res) => {
  try {
    const {
      botId,
      chatID,
      chatId,
      bubbleVersion,
      userId,
      sessionId,
      message,
      userMessage,
      botMessage,
      credits,
      creditsUsed,
      timestamp,
    } = req.body || {};

    if (!botId) return res.status(400).json({ error: 'botId required' });
    if (botId !== req.namespace) return res.status(403).json({ error: 'Invalid bot scope' });

    const finalUserMessage = String(userMessage || message || '').trim();
    const finalBotMessage = String(botMessage || '').trim() || 'No response.';
    const finalCredits = normalizeNumber(creditsUsed ?? credits);

    const payload = {
      botId: String(botId || ''),
      chatID: String(chatID || chatId || botId || ''),
      bubbleVersion: bubbleVersion || 'live',
      userId: userId || '',
      sessionId: sessionId || '',
      message: finalUserMessage,
      userMessage: finalUserMessage,
      botMessage: finalBotMessage,
      credits: finalCredits,
      creditsUsed: finalCredits,
      timestamp: timestamp || new Date().toISOString(),
    };

    const bubbleUrl = `${getBubbleApiHost(payload.bubbleVersion)}/api/1.1/wf/create-chat`;
    const headers = {
      'Content-Type': 'application/json',
      'x-chatbot-token': req.chatbotToken,
    };

    if (process.env.BUBBLE_API_KEY) {
      headers.Authorization = `Bearer ${process.env.BUBBLE_API_KEY}`;
    }

    const bubbleResponse = await fetch(bubbleUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
    });

    const responseText = await bubbleResponse.text();
    let responseBody = null;
    try { responseBody = responseText ? JSON.parse(responseText) : null; } catch { responseBody = responseText; }

    if (!bubbleResponse.ok) {
      return res.status(bubbleResponse.status).json({
        error: 'Bubble create-chat failed',
        status: bubbleResponse.status,
        body: responseBody,
      });
    }

    return res.json({ ok: true, bubble: responseBody });
  } catch (error) {
    console.error('bubbleSave error:', error.message);
    return res.status(500).json({ error: 'Bubble save proxy failed' });
  }
});

export default router;
