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
import { getSafeModel } from '../services/modelService.js';

const router = express.Router();
const getAnthropicClient = () => process.env.ANTHROPIC_API_KEY ? new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY }) : null;
const getOpenAIClient = () => process.env.OPENAI_API_KEY ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY }) : null;

const SIMPLE_GREETING_PATTERN = /^(hi|hello|hey|hiya|yo|good morning|good afternoon|good evening)[!.\s]*$/i;
const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;
const PHONE_RE = /(?:\+?\d[\d\s().-]{7,}\d)/;
const MONEY_RE = /(?:£|\$|€|rs\.?|pkr|gbp|usd|eur)\s?\d[\d,]*(?:\.\d+)?|\d[\d,]*(?:\.\d+)?\s?(?:gbp|usd|eur|pkr|rs|rupees|pounds|dollars)/i;
const TIMELINE_RE = /\b(?:today|tomorrow|asap|urgent|this week|next week|this month|next month|\d+\s?(?:day|days|week|weeks|month|months)|two weeks|three weeks|few days|few weeks)\b/i;
const MEETING_RE = /\b(?:book|meeting|appointment|call|consultation|schedule|2pm|\d{1,2}\s?(?:am|pm))\b/i;

const CREDIT_VALUE_USD = Number(process.env.CREDIT_VALUE_USD || 0.001);
const PROFIT_MULTIPLIER = Number(process.env.CREDIT_PROFIT_MULTIPLIER || 10);
const BASE_CREDITS = Number(process.env.BASE_CREDITS || 1);
const MINIMUM_CREDITS = Number(process.env.MINIMUM_CREDITS || 1);

const MODEL_PRICING_USD_PER_1M = {
  'gpt-4o-mini': { input: 0.15, output: 0.6, multiplier: 1 },
  'gpt-4o': { input: 5, output: 15, multiplier: 1 },
  'claude-sonnet': { input: 3, output: 15, multiplier: 1 },
  'claude-opus': { input: 15, output: 75, multiplier: 1 },
  'claude-sonnet-4-5': { input: 3, output: 15, multiplier: 1 },
  'claude-3-5-sonnet': { input: 3, output: 15, multiplier: 1 },
  'claude-3-opus': { input: 15, output: 75, multiplier: 1 },
};

function isSimpleInitialGreeting(message, conversationHistory = []) {
  return conversationHistory.length === 0 && SIMPLE_GREETING_PATTERN.test((message || '').trim());
}

function safeJsonParse(value, fallback = null) {
  if (!value) return fallback;
  if (typeof value === 'object') return value;
  try { return JSON.parse(value); } catch { return fallback; }
}

function cleanValue(value) {
  if (value === undefined || value === null) return null;
  const text = String(value).trim();
  if (!text || ['unknown', 'not specified', 'n/a', 'null', 'undefined'].includes(text.toLowerCase())) return null;
  return text;
}

function estimateTokensFromText(value = '') {
  const text = String(value || '');
  if (!text.trim()) return 0;
  return Math.max(1, Math.ceil(text.length / 4));
}

function estimateTokensFromMessages(messages = []) {
  return messages.reduce((total, item) => total + estimateTokensFromText(`${item?.role || ''}: ${item?.content || ''}`), 0);
}

function getPricingForModel(resolvedModel = {}) {
  const keys = [resolvedModel.modelId, resolvedModel.apiModelId].filter(Boolean);
  for (const key of keys) {
    if (MODEL_PRICING_USD_PER_1M[key]) return MODEL_PRICING_USD_PER_1M[key];
    const lowered = String(key).toLowerCase();
    if (lowered.includes('gpt-4o-mini')) return MODEL_PRICING_USD_PER_1M['gpt-4o-mini'];
    if (lowered.includes('gpt-4o')) return MODEL_PRICING_USD_PER_1M['gpt-4o'];
    if (lowered.includes('opus')) return MODEL_PRICING_USD_PER_1M['claude-opus'];
    if (lowered.includes('sonnet')) return MODEL_PRICING_USD_PER_1M['claude-sonnet'];
  }
  return MODEL_PRICING_USD_PER_1M['gpt-4o-mini'];
}

function normalizeUsageTokens(rawUsage = {}) {
  const inputTokens = Number(rawUsage.inputTokens ?? rawUsage.input_tokens ?? rawUsage.prompt_tokens ?? rawUsage.promptTokens ?? 0);
  const outputTokens = Number(rawUsage.outputTokens ?? rawUsage.output_tokens ?? rawUsage.completion_tokens ?? rawUsage.completionTokens ?? 0);
  return {
    inputTokens: Number.isFinite(inputTokens) && inputTokens > 0 ? inputTokens : 0,
    outputTokens: Number.isFinite(outputTokens) && outputTokens > 0 ? outputTokens : 0,
  };
}

function calculateChatUsage({ systemPrompt = '', messages = [], reply = '', resolvedModel = {}, rawUsage = null }) {
  const exact = normalizeUsageTokens(rawUsage || {});
  const inputTokens = exact.inputTokens || estimateTokensFromText(systemPrompt) + estimateTokensFromMessages(messages);
  const outputTokens = exact.outputTokens || estimateTokensFromText(reply);
  const pricing = getPricingForModel(resolvedModel);
  const inputCostUsd = (inputTokens / 1_000_000) * pricing.input;
  const outputCostUsd = (outputTokens / 1_000_000) * pricing.output;
  const estimatedCostUsd = inputCostUsd + outputCostUsd;
  const creditsUsed = Math.max(
    MINIMUM_CREDITS,
    Math.ceil(BASE_CREDITS + ((estimatedCostUsd * (pricing.multiplier || 1) * PROFIT_MULTIPLIER) / CREDIT_VALUE_USD))
  );
  return {
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
    estimatedCostUsd: Number(estimatedCostUsd.toFixed(8)),
    creditsUsed,
    creditValueUsd: CREDIT_VALUE_USD,
    profitMultiplier: PROFIT_MULTIPLIER,
    modelMultiplier: pricing.multiplier || 1,
  };
}

function createStaticUsage(reply = '', modelId = 'static') {
  return {
    inputTokens: 0,
    outputTokens: estimateTokensFromText(reply),
    totalTokens: estimateTokensFromText(reply),
    estimatedCostUsd: 0,
    creditsUsed: MINIMUM_CREDITS,
    creditValueUsd: CREDIT_VALUE_USD,
    profitMultiplier: PROFIT_MULTIPLIER,
    modelMultiplier: 1,
    model: modelId,
  };
}

function findBalancedJsonObjects(text = '') {
  const source = String(text || '');
  const objects = [];
  let start = -1;
  let depth = 0;
  let inString = false;
  let escapeNext = false;
  for (let i = 0; i < source.length; i += 1) {
    const char = source[i];
    if (escapeNext) { escapeNext = false; continue; }
    if (char === '\\' && inString) { escapeNext = true; continue; }
    if (char === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (char === '{') { if (depth === 0) start = i; depth += 1; }
    else if (char === '}' && depth > 0) {
      depth -= 1;
      if (depth === 0 && start >= 0) { objects.push(source.slice(start, i + 1)); start = -1; }
    }
  }
  return objects;
}

function tryParseJsonObject(value) {
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch { return null; }
}

function getLeadJsonCandidates(text = '') {
  return findBalancedJsonObjects(text)
    .map((raw) => ({ raw, parsed: tryParseJsonObject(raw) }))
    .filter((item) => item.parsed);
}

function looksLikeLeadData(data = {}) {
  const keys = Object.keys(data).map((key) => key.toLowerCase());
  const hasContact = ['name', 'full_name', 'fullname', 'email', 'phone', 'phone_number'].some((key) => keys.includes(key));
  const hasLeadFields = ['project_type', 'projecttype', 'service', 'service_needed', 'budget_range', 'budget', 'timeline', 'is_decision_maker', 'lead_score', 'needs', 'business_goal'].some((key) => keys.includes(key));
  return hasContact && hasLeadFields;
}

function extractNameFromText(text = '') {
  const source = String(text || '');
  const patterns = [
    /\b(?:i am|i'm|im|my name is|name is|this is)\s+([A-Z][A-Za-z.'-]{1,30}(?:\s+[A-Z][A-Za-z.'-]{1,30})?)/i,
    /\b(?:name:)\s*([A-Za-z][A-Za-z.'-]{1,30}(?:\s+[A-Za-z][A-Za-z.'-]{1,30})?)/i,
  ];
  for (const pattern of patterns) {
    const match = source.match(pattern);
    if (match?.[1]) return match[1].replace(/\s+(and|email|phone|my|with).*$/i, '').trim();
  }
  return null;
}

function extractProjectTypeFromText(text = '') {
  const source = String(text || '').toLowerCase();
  const serviceWords = ['bathroom renovation', 'bathroom project', 'kitchen renovation', 'plumbing', 'heating', 'electrical', 'eicr', 'maintenance', 'roofing', 'construction', 'refurbishment', 'renovation', 'rennovation', 'fit out', 'office fit out', 'extension', 'repair', 'installation', 'website', 'seo', 'chatbot', 'automation'];
  const found = serviceWords.find((word) => source.includes(word));
  if (found) return found.replace('rennovation', 'renovation').replace(/\b\w/g, (c) => c.toUpperCase());
  const projectMatch = source.match(/(?:i have|i need|looking for|want|need|project is|for)\s+(?:a\s+|an\s+|my\s+)?([a-z\s-]{3,60}?)(?:\s+project|\s+work|\s+service|\s+renovation|\.|,|$)/i);
  if (projectMatch?.[1]) return projectMatch[1].trim().replace(/\b\w/g, (c) => c.toUpperCase());
  return null;
}

function extractBudgetFromText(text = '') { return String(text || '').match(MONEY_RE)?.[0]?.trim() || null; }
function extractTimelineFromText(text = '') { return String(text || '').match(TIMELINE_RE)?.[0]?.trim() || null; }
function extractMeetingPreference(text = '') {
  const source = String(text || '');
  const match = source.match(/\b(?:at\s*)?(\d{1,2}(?::\d{2})?\s?(?:am|pm))\b/i) || source.match(/\b(?:meeting|call|appointment)\s+(?:at\s*)?([^.!?\n]{2,40})/i);
  return match?.[1]?.trim() || null;
}
function extractDecisionMaker(text = '') {
  const source = String(text || '').toLowerCase();
  if (/\b(?:yes|yeah|yep|i am|i'm|im)\b.{0,40}\b(?:decision maker|sign off|owner|approve|approver)\b/.test(source)) return true;
  if (/\b(?:decision maker|sign off|owner|approve|approver)\b.{0,40}\b(?:yes|yeah|yep|i am|i'm|im)\b/.test(source)) return true;
  if (/\b(?:no|not me|someone else|manager|director|partner|committee)\b.{0,50}\b(?:decision maker|sign off|approve|approval)\b/.test(source)) return false;
  return null;
}

function normalizeLeadData(rawData = {}, config = {}, conversationText = '') {
  const data = rawData || {};
  const text = String(conversationText || '');
  const lower = text.toLowerCase();
  const normalized = {
    ...data,
    name: cleanValue(data.name || data.full_name || data.fullName),
    phone: cleanValue(data.phone || data.phone_number || data.phoneNumber),
    email: cleanValue(data.email || data.email_address || data.emailAddress),
    company_name: cleanValue(data.company_name || data.companyName),
    project_type: cleanValue(data.project_type || data.projectType || data.service_needed || data.service || data.needs),
    needs: cleanValue(data.needs || data.business_goal || data.project_details),
    business_goal: cleanValue(data.business_goal),
    budget_range: cleanValue(data.budget_range || data.budget || data.estimated_budget),
    budget_risk_level: cleanValue(data.budget_risk_level),
    budget_risk_reason: cleanValue(data.budget_risk_reason),
    timeline: cleanValue(data.timeline || data.preferred_timeline),
    decision_maker_role: cleanValue(data.decision_maker_role),
    other_stakeholders: cleanValue(data.other_stakeholders),
    preferred_meeting_time: cleanValue(data.preferred_meeting_time || data.meeting_time),
    is_decision_maker: typeof data.is_decision_maker === 'boolean' ? data.is_decision_maker : null,
    appointment_scheduled: Boolean(data.appointment_scheduled || data.has_appointment),
    urgency_flag: Boolean(data.urgency_flag),
    urgency_reason: cleanValue(data.urgency_reason),
    agents_used: Array.isArray(data.agents_used) ? data.agents_used : [],
    score_reasons: Array.isArray(data.score_reasons) ? data.score_reasons : [],
  };
  normalized.email = normalized.email || text.match(EMAIL_RE)?.[0] || null;
  normalized.phone = normalized.phone || text.match(PHONE_RE)?.[0]?.trim() || null;
  normalized.name = normalized.name || extractNameFromText(text);
  normalized.project_type = normalized.project_type || extractProjectTypeFromText(text);
  normalized.budget_range = normalized.budget_range || extractBudgetFromText(text);
  normalized.timeline = normalized.timeline || extractTimelineFromText(text);
  normalized.preferred_meeting_time = normalized.preferred_meeting_time || extractMeetingPreference(text);
  const decision = extractDecisionMaker(text);
  if (normalized.is_decision_maker === null && decision !== null) normalized.is_decision_maker = decision;
  if (!normalized.appointment_scheduled) normalized.appointment_scheduled = MEETING_RE.test(text);
  if (!normalized.urgency_flag && /\b(urgent|asap|emergency|this week|2 weeks|two weeks|soon)\b/i.test(lower)) {
    normalized.urgency_flag = true;
    normalized.urgency_reason = normalized.urgency_reason || 'Short or urgent timeline mentioned';
  }
  const hasEmail = Boolean(normalized.email);
  const hasPhone = Boolean(normalized.phone);
  const hasBudget = Boolean(normalized.budget_range);
  const hasTimeline = Boolean(normalized.timeline);
  const decisionKnown = typeof normalized.is_decision_maker === 'boolean';
  if (!normalized.lead_score || !['hot', 'warm', 'cold'].includes(String(normalized.lead_score).toLowerCase())) {
    if (hasEmail && hasPhone && (hasBudget || hasTimeline || normalized.appointment_scheduled) && (decisionKnown || normalized.project_type)) normalized.lead_score = 'hot';
    else if ((hasEmail || hasPhone) && (normalized.project_type || hasBudget || hasTimeline)) normalized.lead_score = 'warm';
    else normalized.lead_score = 'cold';
  }
  const reasons = new Set(normalized.score_reasons.filter(Boolean));
  if (hasEmail && hasPhone) reasons.add('Contact details provided');
  if (normalized.project_type) reasons.add('Project/service interest captured');
  if (hasBudget) reasons.add('Budget provided');
  if (hasTimeline) reasons.add('Timeline provided');
  if (decisionKnown) reasons.add('Decision-maker status known');
  if (normalized.appointment_scheduled) reasons.add('Meeting requested');
  normalized.score_reasons = [...reasons];
  if (!normalized.agents_used.length && Array.isArray(config.selected_agents)) normalized.agents_used = config.selected_agents;
  normalized.industry_data = normalized.industry_data || { ...normalized };
  return normalized;
}

function mergeLeadData(...profiles) {
  const merged = {};
  for (const profile of profiles) {
    if (!profile || typeof profile !== 'object') continue;
    for (const [key, value] of Object.entries(profile)) {
      if (value === undefined || value === null || value === '') continue;
      if (Array.isArray(value)) merged[key] = [...new Set([...(Array.isArray(merged[key]) ? merged[key] : []), ...value])];
      else if (typeof value === 'object' && !Array.isArray(value)) merged[key] = { ...(typeof merged[key] === 'object' && !Array.isArray(merged[key]) ? merged[key] : {}), ...value };
      else merged[key] = value;
    }
  }
  return merged;
}

function extractLeadDataFromResponse(fullResponse = '', config = {}) {
  const text = String(fullResponse || '');
  const markerMatch = text.match(/LEAD_DATA:\s*({[\s\S]*})/);
  if (markerMatch) {
    const markerCandidates = getLeadJsonCandidates(markerMatch[1]);
    const markedLead = markerCandidates.find((item) => looksLikeLeadData(item.parsed)) || markerCandidates[0];
    if (markedLead) return normalizeLeadData(markedLead.parsed, config, text);
  }
  const candidates = getLeadJsonCandidates(text).filter((item) => looksLikeLeadData(item.parsed));
  if (!candidates.length) return null;
  return normalizeLeadData(candidates[candidates.length - 1].parsed, config, text);
}

function extractLeadDataFromConversation({ session, conversationHistory = [], userMessage = '', assistantMessage = '', config = {} }) {
  const existing = safeJsonParse(session?.collected_data, {}) || {};
  const transcript = [...conversationHistory.map((m) => `${m.role}: ${m.content}`), `user: ${userMessage}`, `assistant: ${assistantMessage}`].join('\n');
  const fromAssistantJson = extractLeadDataFromResponse(assistantMessage, config) || {};
  const fromTranscript = normalizeLeadData({}, config, transcript);
  return normalizeLeadData(mergeLeadData(existing, fromTranscript, fromAssistantJson), config, transcript);
}

function isLeadReady(leadData = {}) {
  return Boolean(leadData.name && (leadData.email || leadData.phone) && (leadData.project_type || leadData.needs || leadData.business_goal || leadData.appointment_scheduled || leadData.budget_range));
}

function removeVisibleLeadJson(text = '') {
  let cleaned = String(text || '');
  for (const item of getLeadJsonCandidates(cleaned)) if (looksLikeLeadData(item.parsed)) cleaned = cleaned.replace(item.raw, '').trim();
  return cleaned;
}
function cleanAssistantResponse(text = '') {
  return removeVisibleLeadJson(String(text || ''))
    .replace(/CALENDLY_BUTTON:\S+/g, '')
    .replace(/PHASE_\d+_COMPLETE/g, '')
    .replace(/LEAD_DATA:\s*({[\s\S]*})\s*(?:\n|$)/g, '')
    .replace(/ESCALATION_REQUIRED/g, '')
    .replace(/URGENT_ESCALATION/g, '')
    .trim();
}

async function saveMessagePair({ sessionId, businessId, userMessage, assistantMessage, phase = 1, modelUsed = null }) {
  await pool.query('INSERT INTO messages (session_id,business_id,role,content,agent_phase,model_used,created_at) VALUES ($1,$2,$3,$4,$5,$6,NOW()),($1,$2,$7,$8,$5,$9,NOW())', [sessionId, businessId, 'user', userMessage, phase, null, 'assistant', assistantMessage, modelUsed]);
  await pool.query('UPDATE sessions SET last_activity_at=NOW() WHERE id=$1', [sessionId]);
}

async function generateLeadSummary(leadData, industry) {
  const prompt = `Write a 2-sentence lead summary for a busy ${industry} business owner. Include: name, need/scope, budget, budget risk if known, decision-maker status if known, and why this is a ${leadData?.lead_score} lead. Be direct. Max 55 words total. Lead: ${JSON.stringify(leadData)} Return: {"summary":"string"}`;
  try {
    const anthropic = getAnthropicClient();
    if (!anthropic) throw new Error('Missing ANTHROPIC_API_KEY');
    const response = await anthropic.messages.create({ model: process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-5', max_tokens: 180, system: 'You write concise CRM lead summaries. Return JSON only. No markdown. No explanation.', messages: [{ role: 'user', content: prompt }] });
    return JSON.parse(response.content?.[0]?.text || '{}').summary;
  } catch {
    try {
      const openai = getOpenAIClient();
      if (!openai) throw new Error('Missing OPENAI_API_KEY');
      const response = await openai.chat.completions.create({ model: process.env.OPENAI_FALLBACK_MODEL || 'gpt-4o-mini', max_tokens: 180, messages: [{ role: 'system', content: 'Return JSON only.' }, { role: 'user', content: prompt }] });
      return JSON.parse(response.choices?.[0]?.message?.content || '{}').summary;
    } catch {
      const score = (leadData?.lead_score || 'unknown').toUpperCase();
      return `[${score}] lead from ${leadData?.name || 'visitor'} regarding ${leadData?.project_type || 'inquiry'}. ${leadData?.budget_range ? `Budget: ${leadData.budget_range}.` : ''}`;
    }
  }
}

async function saveLead(config, sessionId, rawLeadData, namespace) {
  try {
    if (!config || !sessionId || !rawLeadData) return null;
    const leadData = normalizeLeadData(rawLeadData, config, JSON.stringify(rawLeadData));
    if (!isLeadReady(leadData)) {
      console.log('Lead not ready yet', { hasName: Boolean(leadData.name), hasEmail: Boolean(leadData.email), hasPhone: Boolean(leadData.phone), projectType: leadData.project_type });
      return null;
    }
    const dedupeKey = `lead:${namespace}:${sessionId}`;
    const wasAlreadyNotified = await redisClient.get(dedupeKey).catch(() => null);
    const aiSummary = await generateLeadSummary(leadData, config.industry);
    const projectDetails = generateProjectDetails(config.industry, leadData);
    const result = await pool.query(`
      INSERT INTO leads (business_id, session_id, full_name, phone, email, company_name, lead_score, score_reasons, ai_summary, project_details, industry, industry_data, budget_range, is_decision_maker, calendly_link_shown, appointment_scheduled, urgency_flag, urgency_reason, agents_used, source, status, created_at, updated_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,'website_chatbot','new',NOW(),NOW())
      ON CONFLICT (business_id, session_id) WHERE session_id IS NOT NULL
      DO UPDATE SET full_name=COALESCE(EXCLUDED.full_name,leads.full_name), phone=COALESCE(EXCLUDED.phone,leads.phone), email=COALESCE(EXCLUDED.email,leads.email), company_name=COALESCE(EXCLUDED.company_name,leads.company_name), lead_score=EXCLUDED.lead_score, score_reasons=EXCLUDED.score_reasons, ai_summary=EXCLUDED.ai_summary, project_details=EXCLUDED.project_details, industry=EXCLUDED.industry, industry_data=EXCLUDED.industry_data, budget_range=EXCLUDED.budget_range, is_decision_maker=EXCLUDED.is_decision_maker, calendly_link_shown=EXCLUDED.calendly_link_shown, appointment_scheduled=EXCLUDED.appointment_scheduled, urgency_flag=EXCLUDED.urgency_flag, urgency_reason=EXCLUDED.urgency_reason, agents_used=EXCLUDED.agents_used, updated_at=NOW()
      RETURNING *`, [config.business_id, sessionId, leadData.name, leadData.phone, leadData.email, leadData.company_name || null, leadData.lead_score, leadData.score_reasons || [], aiSummary, projectDetails, config.industry, JSON.stringify(leadData.industry_data || leadData), leadData.budget_range, leadData.is_decision_maker, Boolean(config.calendly_link || config.calendlyLink), Boolean(leadData.appointment_scheduled) === true, leadData.urgency_flag || false, leadData.urgency_reason || null, leadData.agents_used || []]);
    const savedLead = result?.rows?.[0];
    if (savedLead?.id) await pool.query("UPDATE sessions SET lead_id=$1, lead_captured=true, status='completed', completed_at=NOW(), collected_data=$3::jsonb WHERE id=$2", [savedLead.id, sessionId, JSON.stringify(leadData)]);
    if (!wasAlreadyNotified && process.env.BUBBLE_API_URL && process.env.BUBBLE_API_KEY && savedLead) {
      fetch(`${process.env.BUBBLE_API_URL}/api/1.1/obj/lead`, { method: 'POST', headers: { Authorization: `Bearer ${process.env.BUBBLE_API_KEY}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ full_name: leadData.name, phone: leadData.phone, email: leadData.email, company_name: leadData.company_name || null, lead_score: leadData.lead_score, status: 'new', industry: config.industry, ai_summary: aiSummary, project_details: projectDetails, budget_range: leadData.budget_range, budget_risk_level: leadData.budget_risk_level || null, budget_risk_reason: leadData.budget_risk_reason || null, is_decision_maker: leadData.is_decision_maker, decision_maker_role: leadData.decision_maker_role || null, other_stakeholders: leadData.other_stakeholders || null, has_appointment: Boolean(leadData.appointment_scheduled) === true, urgency_flag: leadData.urgency_flag || false, session_id: savedLead.id }) }).catch((err) => console.error('Bubble push failed:', err.message));
    }
    if (!wasAlreadyNotified) {
      await redisClient.setex(dedupeKey, 3600, '1').catch((e) => console.error(e.message));
      sendLeadAlert(config, { ...savedLead, project_details: projectDetails, ai_summary: aiSummary, score_reasons: leadData.score_reasons || [] }).catch((err) => console.error('Email alert failed:', err.message));
    }
    return savedLead;
  } catch (error) { console.error('saveLead error:', error.message); return null; }
}

async function updateCollectedData(sessionId, leadData) { await pool.query('UPDATE sessions SET collected_data=$2::jsonb, last_activity_at=NOW() WHERE id=$1', [sessionId, JSON.stringify(leadData)]); }

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
    const cfg = await pool.query(`SELECT bc.system_prompt, bc.selected_agents, bc.selected_model, bc.welcome_message, bc.starter_prompts, bc.is_draft, bc.detected_location, bc.detected_services, b.industry, b.business_name, b.owner_email, b.owner_phone, b.escalation_email, b.primary_color, b.calendly_link, b.availability_slots, b.bot_id, b.id as business_id, b.timezone, b.plan, b.is_disabled, b.disabled_reason FROM bot_configs bc JOIN businesses b ON bc.business_id = b.id WHERE b.bot_id=$1 AND bc.active=true LIMIT 1`, [botId]);
    if (!cfg.rows[0]) return res.status(404).json({ error: 'Bot not configured', message: 'Please complete onboarding first' });
    config = { ...cfg.rows[0], calendlyLink: cfg.rows[0].calendly_link, ownerPhone: cfg.rows[0].owner_phone };
    try { await redisClient.setex(redisBotKey, 3600, JSON.stringify(config)); } catch (e) { console.error(e.message); }
  }
  if (!config?.business_id) return res.status(500).json({ error: 'Invalid bot config' });
  if (config.is_disabled) {
    const disabledMsg = config.disabled_reason || 'This chatbot is temporarily unavailable. Please contact the business directly.';
    const usage = { ...createStaticUsage(disabledMsg, 'disabled'), creditsUsed: 0 };
    if (isStreaming) { res.setHeader('Content-Type', 'text/event-stream'); res.setHeader('Cache-Control', 'no-cache'); res.setHeader('Connection', 'keep-alive'); res.setHeader('X-Accel-Buffering', 'no'); res.write('data: {"type":"ready"}\n\n'); res.write('data: ' + JSON.stringify({ text: disabledMsg, token: disabledMsg }) + '\n\n'); res.write('data: ' + JSON.stringify({ type: 'meta', reply: disabledMsg, isDisabled: true, creditsUsed: usage.creditsUsed, usage }) + '\n\n'); res.write('data: [DONE]\n\n'); res.end(); } else res.json({ reply: disabledMsg, isDisabled: true, creditsUsed: usage.creditsUsed, usage });
    return;
  }

  const triageKeywords = ['chest pain', 'cant breathe', 'cannot breathe', 'difficulty breathing', 'unconscious', 'overdose', 'stroke', 'severe bleeding', 'collapsed', 'heart attack', 'seizure', 'not responsive', 'dying', 'life threatening', 'emergency help', 'ambulance'];
  if (config.industry === 'healthcare' && triageKeywords.some((kw) => message.toLowerCase().includes(kw))) {
    const triageText = `This sounds urgent. Please call emergency services immediately or go to your nearest emergency room. Do not wait for a callback from us. If you need our direct line right now: ${config.owner_phone || config.ownerPhone || 'contact reception directly'}`;
    const usage = createStaticUsage(triageText, 'static-triage');
    await pool.query("INSERT INTO sessions (id,business_id,current_phase,collected_data,status,started_at,last_activity_at) VALUES ($1,$2,1,'{}','active',NOW(),NOW()) ON CONFLICT (id) DO NOTHING", [sessionId, config.business_id]);
    await Promise.allSettled([saveMessagePair({ sessionId, businessId: config.business_id, userMessage: message, assistantMessage: triageText, phase: 1 }), pool.query("UPDATE sessions SET status = 'escalated', last_activity_at = NOW() WHERE id = $1", [sessionId])]);
    sendUrgentEscalation(config, sessionId, message).catch((e) => console.error(e.message));
    if (isStreaming) { res.setHeader('Content-Type', 'text/event-stream'); res.setHeader('Cache-Control', 'no-cache'); res.setHeader('Connection', 'keep-alive'); res.setHeader('X-Accel-Buffering', 'no'); res.write('data: {"type":"ready"}\n\n'); res.write(`data: ${JSON.stringify({ text: triageText, token: triageText })}\n\n`); res.write(`data: ${JSON.stringify({ type: 'meta', reply: triageText, creditsUsed: usage.creditsUsed, usage })}\n\n`); res.write('data: [DONE]\n\n'); res.end(); } else res.json({ reply: triageText, creditsUsed: usage.creditsUsed, usage });
    return;
  }

  const escalationDetected = ['speak to someone', 'speak to a person', 'call me', 'real person', 'human agent', 'talk to someone', 'complaint', 'legal action', 'urgent help', 'want to speak'].some((kw) => message.toLowerCase().includes(kw));
  let session = (await pool.query('SELECT * FROM sessions WHERE id=$1', [sessionId])).rows[0] || null;
  if (!session) { await pool.query("INSERT INTO sessions (id,business_id,current_phase,collected_data,status,started_at,last_activity_at) VALUES ($1,$2,1,'{}','active',NOW(),NOW()) ON CONFLICT (id) DO NOTHING", [sessionId, config.business_id]); session = { current_phase: 1, collected_data: {} }; }
  const historyRows = await pool.query('SELECT role, content FROM messages WHERE session_id=$1 ORDER BY created_at ASC LIMIT 30', [sessionId]);
  const conversationHistory = historyRows.rows.map((row) => ({ role: row.role, content: row.content }));
  const currentPhase = session?.current_phase || 1;

  if (isSimpleInitialGreeting(message, conversationHistory)) {
    const greetingReply = `Hi — happy to help. What are you looking to get done${config.business_name ? ` with ${config.business_name}` : ''}?`;
    const usage = createStaticUsage(greetingReply, 'static-greeting');
    await saveMessagePair({ sessionId, businessId: config.business_id, userMessage: message, assistantMessage: greetingReply, phase: currentPhase });
    await updateCollectedData(sessionId, extractLeadDataFromConversation({ session, conversationHistory, userMessage: message, assistantMessage: greetingReply, config })).catch((e) => console.error('collected_data update failed:', e.message));
    if (isStreaming) { res.setHeader('Content-Type', 'text/event-stream'); res.setHeader('Cache-Control', 'no-cache'); res.setHeader('Connection', 'keep-alive'); res.setHeader('X-Accel-Buffering', 'no'); res.write('data: {"type":"ready"}\n\n'); res.write(`data: ${JSON.stringify({ text: greetingReply, token: greetingReply })}\n\n`); res.write(`data: ${JSON.stringify({ type: 'meta', reply: greetingReply, model: 'static-greeting', wasDowngraded: false, creditsUsed: usage.creditsUsed, usage })}\n\n`); res.write('data: [DONE]\n\n'); res.end(); } else res.json({ reply: greetingReply, resolvedModel: { modelId: 'static-greeting', provider: 'static', wasDowngraded: false }, creditsUsed: usage.creditsUsed, usage });
    return;
  }

  const chunks = await getRelevantChunks(config.business_id, message, req.namespace, 5);
  const contextText = chunks.length > 0 ? chunks.map((c) => c.content).join('\n\n') : '';
  const businessInfo = { industry: config.industry, businessName: config.business_name, primaryServices: Array.isArray(config.detected_services) ? config.detected_services : [], location: config.detected_location || '', ownerPhone: config.owner_phone || '', calendlyLink: config.calendly_link || null };
  const selectedAgents = Array.isArray(config.selected_agents) ? config.selected_agents : [];
  const availability = config.availability_slots || {};
  const approvedSystemPrompt = config.system_prompt ? '\nAPPROVED BUSINESS PROMPT:\n' + config.system_prompt + '\n' : '';
  const agentSystemPrompt = selectedAgents.length > 0 ? buildMasterPrompt(businessInfo, selectedAgents, availability, { phase: currentPhase }) + approvedSystemPrompt : buildMasterPrompt(config.system_prompt || '', { phase: currentPhase });
  const ragBlock = contextText ? 'KNOWLEDGE BASE:\n' + contextText + '\nUse this to answer accurately.\n\n' : '';
  const fullSystemPrompt = ragBlock + agentSystemPrompt;
  const messagesArray = [...conversationHistory, { role: 'user', content: message }];

  const callWithFallback = async (stream, botConfig, systemPrompt, messages) => {
    const resolvedModel = await getSafeModel(botConfig.selected_model || 'gpt-4o-mini', botConfig.plan || 'trial');
    console.log('[chat] Model resolved', { businessId: botConfig.business_id, plan: botConfig.plan, requested: botConfig.selected_model, using: resolvedModel.modelId, provider: resolvedModel.provider, wasDowngraded: resolvedModel.wasDowngraded });
    if (resolvedModel.provider === 'anthropic') {
      if (stream) { const anthropic = getAnthropicClient(); if (!anthropic) throw new Error('Missing ANTHROPIC_API_KEY'); const anthropicStream = await anthropic.messages.stream({ model: resolvedModel.apiModelId, max_tokens: 1000, system: systemPrompt, messages }); return { stream: anthropicStream, resolvedModel }; }
      try { const anthropic = getAnthropicClient(); if (!anthropic) throw new Error('Missing ANTHROPIC_API_KEY'); const response = await anthropic.messages.create({ model: resolvedModel.apiModelId, max_tokens: 1000, system: systemPrompt, messages }); return { reply: response.content[0].text, resolvedModel, rawUsage: response.usage }; }
      catch (anthropicErr) { console.warn('[chat] Anthropic failed, falling back to OpenAI:', anthropicErr.message); const openai = getOpenAIClient(); if (!openai) throw anthropicErr; const fb = await openai.chat.completions.create({ model: process.env.OPENAI_FALLBACK_MODEL || 'gpt-4o-mini', max_tokens: 1000, messages: [{ role: 'system', content: systemPrompt }, ...messages] }); return { reply: fb.choices[0].message.content, resolvedModel: { ...resolvedModel, wasDowngraded: true }, rawUsage: fb.usage }; }
    }
    if (resolvedModel.provider === 'openai') {
      const openaiMessages = [{ role: 'system', content: systemPrompt }, ...messages];
      const openai = getOpenAIClient(); if (!openai) throw new Error('Missing OPENAI_API_KEY');
      if (stream) { const openaiStream = await openai.chat.completions.create({ model: resolvedModel.apiModelId, max_tokens: 1000, stream: true, messages: openaiMessages }); const wrappedStream = { [Symbol.asyncIterator]: async function* () { for await (const chunk of openaiStream) { const text = chunk.choices[0]?.delta?.content; if (text) yield { type: 'content_block_delta', delta: { type: 'text_delta', text } }; } } }; return { stream: wrappedStream, resolvedModel }; }
      const response = await openai.chat.completions.create({ model: resolvedModel.apiModelId, max_tokens: 1000, messages: openaiMessages }); return { reply: response.choices[0].message.content, resolvedModel, rawUsage: response.usage };
    }
    throw new Error('[chat] Unknown provider: ' + resolvedModel.provider);
  };

  const processResponse = async (fullResponse, result) => {
    await saveMessagePair({ sessionId, businessId: config.business_id, userMessage: message, assistantMessage: fullResponse, phase: currentPhase, modelUsed: result.resolvedModel.apiModelId });
    const phaseMatch = fullResponse.match(/PHASE_(\d+)_COMPLETE/);
    if (phaseMatch) await pool.query('UPDATE sessions SET current_phase=$1,last_activity_at=NOW() WHERE id=$2', [Number.parseInt(phaseMatch[1], 10) + 1, sessionId]); else await pool.query('UPDATE sessions SET last_activity_at=NOW() WHERE id=$1', [sessionId]);
    if (fullResponse.includes('ESCALATION_REQUIRED') || escalationDetected) { await pool.query("UPDATE sessions SET status = 'escalated' WHERE id=$1", [sessionId]); sendUrgentEscalation(config, sessionId, message).catch((e) => console.error(e.message)); }
    const leadData = extractLeadDataFromConversation({ session, conversationHistory, userMessage: message, assistantMessage: fullResponse, config });
    await updateCollectedData(sessionId, leadData);
    if (isLeadReady(leadData)) await saveLead(config, sessionId, leadData, req.namespace);
    else console.log('Lead profile updated but not ready to save yet', { sessionId, keys: Object.keys(leadData).filter((key) => leadData[key]) });
  };

  if (isStreaming) {
    res.setHeader('Content-Type', 'text/event-stream'); res.setHeader('Cache-Control', 'no-cache'); res.setHeader('Connection', 'keep-alive'); res.setHeader('X-Accel-Buffering', 'no'); res.write('data: {"type":"ready"}\n\n');
    const keepAlive = setInterval(() => res.write(': keep-alive\n\n'), 15000);
    const timeout = setTimeout(() => { clearInterval(keepAlive); res.write('data: [DONE]\n\n'); res.end(); }, 30000);
    let fullResponse = ''; let calendlyUrl = null;
    try {
      const result = await callWithFallback(true, config, fullSystemPrompt, messagesArray);
      for await (const chunk of result.stream) { if (chunk.type === 'content_block_delta' && chunk.delta?.type === 'text_delta') { const token = chunk.delta.text; fullResponse += token; res.write(`data: ${JSON.stringify({ text: token, token })}\n\n`); } }
      clearInterval(keepAlive); clearTimeout(timeout);
      const calendlyMatch = fullResponse.match(/CALENDLY_BUTTON:(\S+)/); if (calendlyMatch) calendlyUrl = calendlyMatch[1];
      if (calendlyUrl) res.write(`data: ${JSON.stringify({ type: 'calendly_button', url: calendlyUrl, label: 'Book Your Appointment →' })}\n\n`);
      const cleanResponse = cleanAssistantResponse(fullResponse);
      const usage = calculateChatUsage({ systemPrompt: fullSystemPrompt, messages: messagesArray, reply: cleanResponse || fullResponse, resolvedModel: result.resolvedModel, rawUsage: result.rawUsage });
      result.usage = usage;
      res.write(`data: ${JSON.stringify({ type: 'meta', reply: cleanResponse, model: result.resolvedModel.modelId, wasDowngraded: result.resolvedModel.wasDowngraded, creditsUsed: usage.creditsUsed, usage })}\n\n`); res.write('data: [DONE]\n\n'); res.end();
      processResponse(fullResponse, result).catch((e) => console.error('processResponse error:', e.message));
    } catch (streamError) { clearInterval(keepAlive); clearTimeout(timeout); res.write(`data: ${JSON.stringify({ type: 'error', message: 'Something went wrong. Please try again.' })}\n\n`); res.write('data: [DONE]\n\n'); res.end(); }
    return;
  }
  try {
    const result = await callWithFallback(false, config, fullSystemPrompt, messagesArray);
    const fullResponse = result.reply;
    const calendlyMatch = fullResponse.match(/CALENDLY_BUTTON:(\S+)/);
    const calendlyUrl = calendlyMatch ? calendlyMatch[1] : null;
    const cleanResponse = cleanAssistantResponse(fullResponse);
    const usage = calculateChatUsage({ systemPrompt: fullSystemPrompt, messages: messagesArray, reply: cleanResponse || fullResponse, resolvedModel: result.resolvedModel, rawUsage: result.rawUsage });
    result.usage = usage;
    res.json({ reply: cleanResponse, calendlyUrl, resolvedModel: result.resolvedModel, creditsUsed: usage.creditsUsed, usage });
    processResponse(fullResponse, result).catch((e) => console.error('processResponse error:', e.message));
  } catch { res.status(500).json({ error: 'Something went wrong. Please try again.' }); }
});

export default router;