import express from 'express';
import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import pool from '../db/pool.js';
import { getRelevantChunks } from '../db/vectorStore.js';
import { buildMasterPrompt, generateProjectDetails } from '../agents/promptBuilder.js';
import { sendLeadAlert, sendUrgentEscalation } from '../services/emailService.js';
import { sanitizeMessage } from '../middleware/sanitize.js';
import { tokenAuth } from '../middleware/tokenAuth.js';
import { domainRestriction } from '../middleware/domainRestriction.js';
import { redisClient } from '../services/redis.js';

const router = express.Router();
const getAnthropicClient = () => process.env.ANTHROPIC_API_KEY ? new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY }) : null;
const getOpenAIClient = () => process.env.OPENAI_API_KEY ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY }) : null;

async function generateLeadSummary(leadData, industry) {
  const prompt = `Write a 2-sentence lead summary for a busy ${industry} business owner. Include: name, what they need, budget if known, and why this is a ${leadData?.lead_score} lead. Be direct. Max 40 words total. Lead: ${JSON.stringify(leadData)} Return: {"summary":"string"}`;
  try {
    const anthropic = getAnthropicClient();
    if (!anthropic) throw new Error('Missing ANTHROPIC_API_KEY');
    const response = await anthropic.messages.create({ model: process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-5', max_tokens: 150, system: 'You write concise CRM lead summaries. Return JSON only. No markdown. No explanation.', messages: [{ role: 'user', content: prompt }] });
    return JSON.parse(response.content?.[0]?.text || '{}').summary;
  } catch {
    try {
      const openai = getOpenAIClient();
      if (!openai) throw new Error('Missing OPENAI_API_KEY');
      const response = await openai.chat.completions.create({ model: process.env.OPENAI_FALLBACK_MODEL || 'gpt-4o-mini', max_tokens: 150, messages: [{ role: 'system', content: 'Return JSON only.' }, { role: 'user', content: prompt }] });
      return JSON.parse(response.choices?.[0]?.message?.content || '{}').summary;
    } catch {
      const score = (leadData?.lead_score || 'unknown').toUpperCase();
      return `[${score}] lead from ${leadData?.name || 'visitor'} regarding ${leadData?.project_type || 'inquiry'}. ${leadData?.budget_range ? `Budget: ${leadData.budget_range}.` : ''}`;
    }
  }
}

async function saveLead(config, sessionId, leadData, namespace) {
  try {
    if (!config || !sessionId || !leadData) return;
    const dedupeKey = `lead:${namespace}:${sessionId}`;
    try { if (await redisClient.get(dedupeKey)) return console.log('Duplicate lead skipped'); } catch (e) { console.error(e.message); }
    const aiSummary = await generateLeadSummary(leadData, config.industry);
    const projectDetails = generateProjectDetails(config.industry, leadData);
    const result = await pool.query(`
  INSERT INTO leads (
    business_id, session_id, full_name, phone, email, company_name,
    lead_score, score_reasons, ai_summary, project_details,
    industry, industry_data, budget_range, is_decision_maker,
    calendly_link_shown, appointment_scheduled, urgency_flag, urgency_reason,
    agents_used, source, status, created_at, updated_at
  ) VALUES (
    $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,
    $11,$12,$13,$14,$15,$16,$17,$18,
    $19,'website_chatbot','new',NOW(),NOW()
  )
  ON CONFLICT (business_id, session_id)
  WHERE session_id IS NOT NULL
  DO UPDATE SET
    full_name = COALESCE(EXCLUDED.full_name, leads.full_name),
    phone = COALESCE(EXCLUDED.phone, leads.phone),
    email = COALESCE(EXCLUDED.email, leads.email),
    company_name = COALESCE(EXCLUDED.company_name, leads.company_name),
    lead_score = EXCLUDED.lead_score,
    score_reasons = EXCLUDED.score_reasons,
    ai_summary = EXCLUDED.ai_summary,
    project_details = EXCLUDED.project_details,
    industry = EXCLUDED.industry,
    industry_data = EXCLUDED.industry_data,
    budget_range = EXCLUDED.budget_range,
    is_decision_maker = EXCLUDED.is_decision_maker,
    calendly_link_shown = EXCLUDED.calendly_link_shown,
    urgency_flag = EXCLUDED.urgency_flag,
    urgency_reason = EXCLUDED.urgency_reason,
    agents_used = EXCLUDED.agents_used,
    updated_at = NOW()
  RETURNING *
`, [
  config.business_id, sessionId,
  leadData.name, leadData.phone, leadData.email, leadData.company_name || null,
  leadData.lead_score, leadData.score_reasons || [],
  aiSummary, projectDetails,
  config.industry,
  JSON.stringify(leadData.industry_data || leadData),
  leadData.budget_range, leadData.is_decision_maker,
  Boolean(config.calendly_link || config.calendlyLink),
  false,   // appointment_scheduled – placeholder; will be set later if needed
  leadData.urgency_flag || false,
  leadData.urgency_reason || null,
  leadData.agents_used || []
]);
    const savedLead = result?.rows?.[0];
    if (savedLead?.id) {
      await pool.query("UPDATE sessions SET lead_id=$1, lead_captured=true, status='completed', completed_at=NOW() WHERE id=$2", [savedLead.id, sessionId]);
    }
    try { await redisClient.setex(dedupeKey, 3600, '1'); } catch (e) { console.error(e.message); }
    if (process.env.BUBBLE_API_URL && process.env.BUBBLE_API_KEY && savedLead) {
      fetch(`${process.env.BUBBLE_API_URL}/api/1.1/obj/lead`, { method: 'POST', headers: { Authorization: `Bearer ${process.env.BUBBLE_API_KEY}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ full_name: leadData.name, phone: leadData.phone, email: leadData.email, lead_score: leadData.lead_score, status: 'new', industry: config.industry, ai_summary: aiSummary, project_details: projectDetails, budget_range: leadData.budget_range, is_decision_maker: leadData.is_decision_maker, has_appointment: false, urgency_flag: leadData.urgency_flag || false, session_id: savedLead.id }) }).catch((err) => console.error('Bubble push failed:', err.message));
    }
    sendLeadAlert(config, { ...savedLead, project_details: projectDetails, ai_summary: aiSummary, score_reasons: leadData.score_reasons || [] }).catch((err) => console.error('Email alert failed:', err.message));
  } catch (error) { console.error('saveLead error:', error.message); }
}

router.post('/', tokenAuth, domainRestriction, async (req, res) => {
  const isStreaming = req.query.stream === 'true';
  let { botId, sessionId, message } = req.body;
  if (!botId) return res.status(400).json({ error: 'botId required' });
  if (!sessionId) return res.status(400).json({ error: 'sessionId required' });
  if (!message) return res.status(400).json({ error: 'message required' });
  if (botId !== req.namespace) return res.status(403).json({ error: 'Invalid bot scope' });
  message = sanitizeMessage(message);
  if (message.length < 1) return res.status(400).json({ error: 'Message empty after sanitize' });

  let config;
  const redisBotKey = `chatbot_config:${req.namespace}`;
  try { const cached = await redisClient.get(redisBotKey); if (cached) config = JSON.parse(cached); } catch (e) { console.error('Redis cache miss error', e.message); }
  if (!config) {
    const cfg = await pool.query(`SELECT bc.system_prompt, bc.selected_agents, bc.welcome_message, bc.starter_prompts, bc.is_draft, b.industry, b.business_name, b.owner_email, b.owner_phone, b.escalation_email, b.primary_color, b.calendly_link, b.availability_slots, b.bot_id, b.id as business_id, b.timezone FROM bot_configs bc JOIN businesses b ON bc.business_id = b.id WHERE b.bot_id=$1 AND bc.active=true LIMIT 1`, [botId]);
    if (!cfg.rows[0]) return res.status(404).json({ error: 'Bot not configured', message: 'Please complete onboarding first' });
    config = { ...cfg.rows[0], calendlyLink: cfg.rows[0].calendly_link, ownerPhone: cfg.rows[0].owner_phone };
    try { await redisClient.setex(redisBotKey, 3600, JSON.stringify(config)); } catch (e) { console.error(e.message); }
  }
  if (!config?.business_id) return res.status(500).json({ error: 'Invalid bot config' });

  const triageKeywords = ['chest pain', 'cant breathe', 'cannot breathe', 'difficulty breathing', 'unconscious', 'overdose', 'suicidal', 'suicide', 'stroke', 'severe bleeding', 'collapsed', 'heart attack', 'seizure', 'not responsive', 'dying', 'life threatening', 'emergency help', 'ambulance'];
  if (config.industry === 'healthcare' && triageKeywords.some((kw) => message.toLowerCase().includes(kw))) {
    const triageText = `This sounds urgent. Please call 911 immediately or go to your nearest emergency room. Do not wait for a callback from us. If you need our direct line right now: ${config.owner_phone || config.ownerPhone || 'contact reception directly'}`;
    await pool.query("INSERT INTO sessions (id,business_id,current_phase,collected_data,status,started_at,last_activity_at) VALUES ($1,$2,1,'{}','active',NOW(),NOW()) ON CONFLICT (id) DO NOTHING", [sessionId, config.business_id]);
    await Promise.allSettled([
      pool.query('INSERT INTO messages (session_id,business_id,role,content,agent_phase,model_used,created_at) VALUES ($1,$2,$3,$4,$5,$6,NOW()),($1,$2,$7,$8,$5,$9,NOW())', [sessionId, config.business_id, 'user', message, 1, null, 'assistant', triageText, null]),
      pool.query("UPDATE sessions SET status = 'escalated', last_activity_at = NOW() WHERE id = $1", [sessionId]),
    ]);
    sendUrgentEscalation(config, sessionId, message).catch((e) => console.error(e.message));
    if (isStreaming) {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('X-Accel-Buffering', 'no');
      res.write(`data: ${JSON.stringify({ text: triageText, token: triageText })}\n\n`);
      res.write(`data: ${JSON.stringify({ type: 'meta', reply: triageText })}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
    } else {
      res.json({ reply: triageText });
    }
    return;
  }

  const escalationDetected = ['speak to someone', 'speak to a person', 'call me', 'real person', 'human agent', 'talk to someone', 'complaint', 'legal action', 'urgent help', 'want to speak'].some((kw) => message.toLowerCase().includes(kw));
  let session = (await pool.query('SELECT * FROM sessions WHERE id=$1', [sessionId])).rows[0] || null;
  if (!session) { await pool.query("INSERT INTO sessions (id,business_id,current_phase,collected_data,status,started_at,last_activity_at) VALUES ($1,$2,1,'{}','active',NOW(),NOW()) ON CONFLICT (id) DO NOTHING", [sessionId, config.business_id]); session = { current_phase: 1 }; }
  const historyRows = await pool.query('SELECT role, content FROM messages WHERE session_id=$1 ORDER BY created_at ASC LIMIT 20', [sessionId]);
  const conversationHistory = historyRows.rows.map((row) => ({ role: row.role, content: row.content }));
  const chunks = await getRelevantChunks(config.business_id, message, req.namespace, 5);
  const contextText = chunks.length > 0 ? chunks.map((c) => c.content).join('\n\n') : '';
  const ragBlock = contextText ? `KNOWLEDGE BASE ABOUT THIS BUSINESS:\n${contextText}\n\nUse this to answer questions accurately. If not found here do not guess.\n\n` : '';
  const fullSystemPrompt = buildMasterPrompt(config.system_prompt || '', { ragBlock, phase: session?.current_phase || 1 });
  const messagesArray = [...conversationHistory, { role: 'user', content: message }];

  const callWithFallback = async (stream) => {
    try {
      const anthropic = getAnthropicClient(); if (!anthropic) throw new Error('Missing ANTHROPIC_API_KEY');
      if (stream) return anthropic.messages.stream({ model: process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-5', max_tokens: 1000, system: fullSystemPrompt, messages: messagesArray });
      const response = await anthropic.messages.create({ model: process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-5', max_tokens: 1000, system: fullSystemPrompt, messages: messagesArray });
      return { text: response.content?.[0]?.text || '', model: process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-5' };
    } catch (error) {
      console.error('Claude failed, falling back to OpenAI:', error.message);
      if (stream) throw error;
      const openai = getOpenAIClient(); if (!openai) throw error;
      const response = await openai.chat.completions.create({ model: process.env.OPENAI_FALLBACK_MODEL || 'gpt-4o-mini', max_tokens: 1000, messages: [{ role: 'system', content: fullSystemPrompt }, ...messagesArray] });
      return { text: response.choices?.[0]?.message?.content || '', model: process.env.OPENAI_FALLBACK_MODEL || 'gpt-4o-mini' };
    }
  };

  const processResponse = async (fullResponse, usedModel) => {
    const tasks = [];
    tasks.push(pool.query('INSERT INTO messages (session_id,business_id,role,content,agent_phase,model_used,created_at) VALUES ($1,$2,$3,$4,$5,$6,NOW()),($1,$2,$7,$8,$5,$9,NOW())', [sessionId, config.business_id, 'user', message, session?.current_phase || 1, null, 'assistant', fullResponse, usedModel]));
    tasks.push((async () => { const phaseMatch = fullResponse.match(/PHASE_(\d+)_COMPLETE/); if (phaseMatch) await pool.query('UPDATE sessions SET current_phase=$1,last_activity_at=NOW() WHERE id=$2', [Number.parseInt(phaseMatch[1], 10) + 1, sessionId]); else await pool.query('UPDATE sessions SET last_activity_at=NOW() WHERE id=$1', [sessionId]); })());
    tasks.push((async () => { if (fullResponse.includes('ESCALATION_REQUIRED') || escalationDetected) { await pool.query("UPDATE sessions SET status = 'escalated' WHERE id=$1", [sessionId]); sendUrgentEscalation(config, sessionId, message).catch((e) => console.error(e.message)); } })());
    tasks.push((async () => { const leadMatch = fullResponse.match(/LEAD_DATA:\s*({[\s\S]*?})\s*(?:\n|$)/); if (leadMatch) { try { const leadData = JSON.parse(leadMatch[1]); await saveLead(config, sessionId, leadData, req.namespace); } catch (e) { console.error('LEAD_DATA parse failed:', e.message); } } })());
    await Promise.allSettled(tasks);
  };

  if (isStreaming) {
    res.setHeader('Content-Type', 'text/event-stream'); res.setHeader('Cache-Control', 'no-cache'); res.setHeader('Connection', 'keep-alive'); res.setHeader('X-Accel-Buffering', 'no');
    res.write('data: {"type":"ready"}\n\n');
    const keepAlive = setInterval(() => res.write(': keep-alive\n\n'), 15000);
    const timeout = setTimeout(() => { clearInterval(keepAlive); res.write('data: [DONE]\n\n'); res.end(); }, 30000);
    let fullResponse = ''; let calendlyUrl = null;
    try {
      const stream = await callWithFallback(true);
      for await (const chunk of stream) {
        if (chunk.type === 'content_block_delta' && chunk.delta?.type === 'text_delta') {
          const token = chunk.delta.text; fullResponse += token;
          res.write(`data: ${JSON.stringify({ text: token, token })}\n\n`);
        }
      }
      clearInterval(keepAlive); clearTimeout(timeout);
      const calendlyMatch = fullResponse.match(/CALENDLY_BUTTON:(\S+)/); if (calendlyMatch) calendlyUrl = calendlyMatch[1];
      if (calendlyUrl) res.write(`data: ${JSON.stringify({ type: 'calendly_button', url: calendlyUrl, label: 'Book Your Appointment →' })}\n\n`);
      const cleanResponse = fullResponse.replace(/CALENDLY_BUTTON:\S+/g, '').replace(/PHASE_\d+_COMPLETE/g, '').replace(/LEAD_DATA:\s*({[\s\S]*?})\s*(?:\n|$)/g, '').replace(/ESCALATION_REQUIRED/g, '').replace(/URGENT_ESCALATION/g, '').trim();
      res.write(`data: ${JSON.stringify({ type: 'meta', reply: cleanResponse, model: process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-5' })}\n\n`);
      res.write('data: [DONE]\n\n'); res.end();
      processResponse(fullResponse, process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-5').catch((e) => console.error('processResponse error:', e.message));
    } catch (streamError) {
      clearInterval(keepAlive); clearTimeout(timeout);
      res.write(`data: ${JSON.stringify({ type: 'error', message: 'Something went wrong. Please try again.' })}\n\n`); res.write('data: [DONE]\n\n'); res.end();
    }
    return;
  }

  try {
    const { text: fullResponse, model } = await callWithFallback(false);
    const calendlyMatch = fullResponse.match(/CALENDLY_BUTTON:(\S+)/);
    const calendlyUrl = calendlyMatch ? calendlyMatch[1] : null;
    const cleanResponse = fullResponse.replace(/CALENDLY_BUTTON:\S+/g, '').replace(/PHASE_\d+_COMPLETE/g, '').replace(/LEAD_DATA:\s*({[\s\S]*?})\s*(?:\n|$)/g, '').replace(/ESCALATION_REQUIRED/g, '').replace(/URGENT_ESCALATION/g, '').trim();
    res.json({ reply: cleanResponse, calendlyButton: calendlyUrl ? { type: 'calendly_button', url: calendlyUrl, label: 'Book Your Appointment →' } : null });
    processResponse(fullResponse, model).catch((e) => console.error('processResponse error:', e.message));
  } catch {
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

export default router;
