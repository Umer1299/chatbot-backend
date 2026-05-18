import express from 'express';
import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import pool from '../db/pool.js';
import { getRelevantChunks } from '../db/vectorStore.js';
import { buildMasterPrompt, generateProjectDetails } from '../agents/promptBuilder.js';
import { getSafeModel } from '../services/modelService.js';
import { sendLeadAlert, sendUrgentEscalation } from '../services/emailService.js';
import { sanitizeMessage } from '../middleware/sanitize.js';
import { tokenAuth } from '../middleware/tokenAuth.js';
import { domainRestriction } from '../middleware/domainRestriction.js';
import { redisClient } from '../services/redis.js';
import { estimateCost } from '../services/tokenCounter.js';
import { getModelCreditCost } from '../services/modelPricing.js';
import { createChatLogger, getRequestId } from '../utils/chatPerfLogger.js';
import { buildAnthropicPayload } from '../services/anthropicMessageFormatter.js';
import { extractDeterministicLeadData, shouldRunLeadAgent } from '../services/leadDetection.js';
import { safeLeadExtractorErrorCode, withTimeout } from '../services/leadExtractorSafety.js';

const router = express.Router();
const getAnthropicClient = () => process.env.ANTHROPIC_API_KEY ? new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY }) : null;
const getOpenAIClient = () => process.env.OPENAI_API_KEY ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY }) : null;
const DEFAULT_ANTHROPIC_MODEL = 'claude-sonnet-4-6';
const DEFAULT_USAGE = { inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0, creditsUsed: 1 };
const ZERO_USAGE = { inputTokens: 0, outputTokens: 0, totalTokens: 0, estimatedCostUsd: 0, creditsUsed: 0 };
const LEAD_EXTRACTOR_MODEL = process.env.LEAD_EXTRACTOR_MODEL || 'gpt-4o-mini';
const LEAD_EXTRACTOR_MAX_TOKENS = Number(process.env.LEAD_EXTRACTOR_MAX_TOKENS || 300);
const LEAD_EXTRACTOR_TIMEOUT_MS = Number(process.env.LEAD_EXTRACTOR_TIMEOUT_MS || 4000);
const LEAD_EXTRACTOR_ENABLED = String(process.env.LEAD_EXTRACTOR_ENABLED || 'true').toLowerCase() === 'true';

function hasMinimumLeadDataForSave(lead = {}) {
  const email = Boolean(lead.email);
  const phone = Boolean(lead.phone);
  const serviceNeed = Boolean(lead.serviceNeed);
  const companyName = Boolean(lead.companyName || lead.company_name || lead.churchName);
  const name = Boolean(lead.fullName || lead.name);
  return (email && serviceNeed) || (phone && serviceNeed) || (email && companyName) || (phone && companyName) || (name && companyName && serviceNeed);
}

function normalizeMessageForCache(input = '') {
  return String(input).toLowerCase().replace(/[^\w\s]/g, '').replace(/\s+/g, ' ').trim();
}

function detectSimpleIntent(message = '') {
  const normalized = normalizeMessageForCache(message);
  if (!normalized) return null;
  if (/\b(hello|hi|hey|salam|assalamualaikum|good morning|good afternoon|good evening)\b/.test(normalized)) return 'greeting';
  if (/\b(thanks|thank you|jazakallah)\b/.test(normalized)) return 'thanks';
  if (/\b(ok|okay|yes|sure)\b/.test(normalized)) return 'acknowledgement';
  if (/\b(bye|goodbye)\b/.test(normalized)) return 'goodbye';
  if (/\b(book a call|schedule a call|arrange a call)\b/.test(normalized)) return 'booking_intent';
  return null;
}

function buildSimpleReply(intent, config = {}) {
  const businessName = config.business_name ? ` at ${config.business_name}` : '';
  const services = Array.isArray(config.detected_services) && config.detected_services.length > 0
    ? ` We offer ${config.detected_services.slice(0, 3).join(', ')}.`
    : '';
  const bookingLink = config.calendly_link || config.calendlyLink;
  if (intent === 'greeting') return `${config.welcome_message || `Hi! Welcome${businessName}.`}${services}`.trim();
  if (intent === 'thanks') return `You’re very welcome${businessName}! Happy to help anytime.`;
  if (intent === 'acknowledgement') return `Great — sounds good. I’m here whenever you’re ready for the next step.`;
  if (intent === 'goodbye') return `Thanks for chatting${businessName}. Have a blessed day!`;
  if (intent === 'booking_intent') return bookingLink ? `Great — you can book a call here: ${bookingLink}` : `Great idea. Share your preferred day/time and we’ll help arrange the call.`;
  return null;
}

function buildUsageSummary(rawUsage = {}, modelId = 'gpt-4o-mini') {
  const inputTokens = Number.isFinite(rawUsage?.input_tokens) ? rawUsage.input_tokens : 0;
  const outputTokens = Number.isFinite(rawUsage?.output_tokens) ? rawUsage.output_tokens : 0;
  const estimatedCostUsd = estimateCost(modelId, inputTokens, outputTokens);
  const creditsUsed = getModelCreditCost(modelId);
  return { inputTokens, outputTokens, estimatedCostUsd, creditsUsed };
}

function isBetterTextField(existing, candidate) {
  if (!candidate || typeof candidate !== 'string') return false;
  if (!existing) return true;
  return candidate.trim().length > String(existing).trim().length;
}

function mergeLeadData(detLead = {}, aiLead = {}) {
  const merged = { ...detLead };
  const map = {
    fullName: ['fullName', 'name'],
    email: ['email'],
    phone: ['phone'],
    companyName: ['companyName', 'company_name', 'churchName'],
    location: ['location'],
    serviceNeed: ['serviceNeed'],
    budgetRange: ['budgetRange', 'budget_range'],
    timeline: ['timeline']
  };
  Object.entries(map).forEach(([key, aliases]) => {
    const existing = aliases.map((k) => merged[k]).find(Boolean) || null;
    const incoming = aliases.map((k) => aiLead[k]).find(Boolean) || null;
    if ((key === 'email' || key === 'phone') && !incoming) return;
    if (incoming && (isBetterTextField(existing, incoming) || !existing)) aliases.forEach((k) => { merged[k] = incoming; });
  });
  const scoreReasons = Array.from(new Set([...(merged.score_reasons || []), ...(aiLead.scoreReasons || []), 'ai_extractor']));
  merged.score_reasons = scoreReasons;
  if ((merged.email || merged.phone) && (merged.serviceNeed || merged.timeline || merged.budgetRange)) merged.lead_score = 'hot';
  else merged.lead_score = aiLead.leadScore || merged.lead_score || 'warm';
  return merged;
}


async function generateLeadSummary(leadData, industry) {
  const prompt = `Write a 2-sentence lead summary for a busy ${industry} business owner. Include: name, what they need, budget if known, and why this is a ${leadData?.lead_score} lead. Be direct. Max 40 words total. Lead: ${JSON.stringify(leadData)} Return: {"summary":"string"}`;
  try {
    const anthropic = getAnthropicClient();
    if (!anthropic) throw new Error('Missing ANTHROPIC_API_KEY');
    const response = await anthropic.messages.create({ model: process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-5-20250929', max_tokens: 150, system: 'You write concise CRM lead summaries. Return JSON only. No markdown. No explanation.', messages: [{ role: 'user', content: prompt }] });
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
    if (!config || !sessionId || !leadData || !hasMinimumLeadDataForSave(leadData)) return { status: 'skipped', capturedFields: [] };
    const industryData = {
      ...leadData,
      name: leadData.name || leadData.fullName || null,
      fullName: leadData.fullName || leadData.name || null,
      email: leadData.email || null,
      serviceNeed: leadData.serviceNeed || null,
      location: leadData.location || null,
      companyName: leadData.companyName || leadData.company_name || leadData.churchName || null,
      company_name: leadData.companyName || leadData.company_name || leadData.churchName || null,
      churchName: leadData.churchName || leadData.companyName || leadData.company_name || null,
      budgetRange: leadData.budgetRange || leadData.budget_range || null,
      budget_range: leadData.budgetRange || leadData.budget_range || null,
      timeline: leadData.timeline || null
    };
    const normalizedLead = { ...leadData, ...industryData };
    const capturedFields = Object.keys(normalizedLead).filter((k) => normalizedLead[k]);
    const aiSummary = await generateLeadSummary(normalizedLead, config.industry);
    const projectDetails = generateProjectDetails(config.industry, normalizedLead);

    const existingByEmail = leadData.email
      ? (await pool.query('SELECT * FROM leads WHERE business_id=$1 AND email=$2 ORDER BY updated_at DESC LIMIT 1', [config.business_id, leadData.email])).rows[0]
      : null;
    const existingByPhone = (!existingByEmail && leadData.phone)
      ? (await pool.query('SELECT * FROM leads WHERE business_id=$1 AND phone=$2 ORDER BY updated_at DESC LIMIT 1', [config.business_id, leadData.phone])).rows[0]
      : null;
    const existingBySession = (!existingByEmail && !existingByPhone)
      ? (await pool.query('SELECT * FROM leads WHERE business_id=$1 AND session_id=$2 ORDER BY updated_at DESC LIMIT 1', [config.business_id, sessionId])).rows[0]
      : null;
    const hasConflictWithSession = existingBySession && (
      (leadData.email && existingBySession.email && leadData.email !== existingBySession.email) ||
      (normalizedLead.companyName && existingBySession.company_name && normalizedLead.companyName !== existingBySession.company_name) ||
      (normalizedLead.name && existingBySession.full_name && normalizedLead.name !== existingBySession.full_name)
    );
    const existingLead = hasConflictWithSession ? null : (existingByEmail || existingByPhone || existingBySession || null);

    const upsertResult = await pool.query(`
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
        full_name = COALESCE(leads.full_name, EXCLUDED.full_name),
        phone = COALESCE(leads.phone, EXCLUDED.phone),
        email = COALESCE(leads.email, EXCLUDED.email),
        company_name = COALESCE(leads.company_name, EXCLUDED.company_name),
        lead_score = COALESCE(EXCLUDED.lead_score, leads.lead_score),
        score_reasons = CASE WHEN array_length(leads.score_reasons,1) > 0 THEN leads.score_reasons ELSE EXCLUDED.score_reasons END,
        ai_summary = COALESCE(leads.ai_summary, EXCLUDED.ai_summary),
        project_details = COALESCE(leads.project_details, EXCLUDED.project_details),
        industry_data = leads.industry_data || EXCLUDED.industry_data,
        urgency_flag = leads.urgency_flag OR EXCLUDED.urgency_flag,
        urgency_reason = COALESCE(leads.urgency_reason, EXCLUDED.urgency_reason),
        agents_used = CASE WHEN array_length(leads.agents_used,1) > 0 THEN leads.agents_used ELSE EXCLUDED.agents_used END,
        updated_at = NOW()
      RETURNING *
    `, [
      config.business_id, sessionId,
      normalizedLead.name || null, normalizedLead.phone || null, normalizedLead.email || null, normalizedLead.companyName || null,
      normalizedLead.lead_score || 'warm', normalizedLead.score_reasons || [],
      aiSummary, projectDetails,
      config.industry,
      JSON.stringify({ ...industryData, namespace, botId: namespace }),
      normalizedLead.budget_range || normalizedLead.budgetRange || null, normalizedLead.is_decision_maker || null,
      Boolean(config.calendly_link || config.calendlyLink),
      false,
      normalizedLead.urgency_flag || false,
      normalizedLead.urgency_reason || null,
      normalizedLead.agents_used || []
    ]);

    let status = 'inserted';
    if (existingLead) {
      status = existingByEmail || existingByPhone ? 'deduped' : 'updated';
      await pool.query(`
        UPDATE leads SET
          full_name = COALESCE(full_name, $1),
          phone = COALESCE(phone, $2),
          email = COALESCE(email, $3),
          company_name = COALESCE(company_name, $4),
          lead_score = COALESCE(lead_score, $5),
          score_reasons = CASE WHEN array_length(score_reasons,1) > 0 THEN score_reasons ELSE $6 END,
          ai_summary = COALESCE(ai_summary, $7),
          project_details = COALESCE(project_details, $8),
          industry_data = industry_data || $9::jsonb,
          updated_at = NOW()
        WHERE id = $10
      `,[normalizedLead.name||null,normalizedLead.phone||null,normalizedLead.email||null,normalizedLead.companyName||null,normalizedLead.lead_score||'warm',normalizedLead.score_reasons||[],aiSummary,projectDetails,JSON.stringify({ ...industryData, namespace, botId: namespace }),existingLead.id]);
    }

    const savedLead = existingLead || upsertResult?.rows?.[0];
    if (savedLead?.id) {
      await pool.query("UPDATE sessions SET lead_id=$1, lead_captured=true, status='completed', completed_at=NOW() WHERE id=$2", [savedLead.id, sessionId]);
    }
    sendLeadAlert(config, { ...savedLead, project_details: projectDetails, ai_summary: aiSummary, score_reasons: normalizedLead.score_reasons || [] }).catch((err) => console.error('Email alert failed:', err.message));
    return { status, capturedFields };
  } catch (error) {
    console.error('lead_save_failed', { error: error?.message || 'unknown_error' });
    return { status: 'failed', capturedFields: [] };
  }
}

// ── Analytics helpers ──
function detectIntentCategory(text) {
  const lower = text.toLowerCase();
  if (lower.match(/\b(price|cost|how much|budget|quote|fee|discount)\b/)) return 'pricing';
  if (lower.match(/\b(book|schedule|appointment|calendar|reserve|availability)\b/)) return 'booking';
  if (lower.match(/\b(service|offer|provide|we do|can you|cabinet|floor|paint|install|repair|renovate)\b/)) return 'services';
  if (lower.match(/\b(where|location|address|area|city|near|serve)\b/)) return 'location';
  if (lower.match(/\b(help|support|problem|issue|not working|how to)\b/)) return 'support';
  if (lower.match(/\b(angry|bad|terrible|refund|complain|unhappy|want to speak)\b/)) return 'complaint';
  return 'unknown';
}

function checkIfUnanswered(aiReply, contextUsed) {
  const lower = aiReply.toLowerCase();
  const short = aiReply.length < 20;
  const noContext = !contextUsed || contextUsed.length === 0;
  if (lower.includes("i don't know") || lower.includes("i'm not sure") ||
      lower.includes("i don't have that information") || lower.includes('please contact')) {
    return true;
  }
  if (short && noContext) return true;
  return false;
}

router.post('/', tokenAuth, domainRestriction, async (req, res) => {
  const isStreaming = req.query.stream === 'true';

  const requestId = req.requestId || getRequestId(req);
  req.requestId = requestId;
  const requestStart = performance.now();
  const perf = createChatLogger({ event: 'chat_request_start', requestId, namespace: req.namespace || null, sessionId: req.body?.sessionId || null });
  perf.log('chat_request_start', { stream: isStreaming });
  const summary = { status: 'error', leadExtractionAttempted: false, leadDataDetected: false, leadCaptureStatus: 'skipped', capturedFields: [], redisTokenCacheHit: req.redisTokenCacheHit ?? false, botConfigCacheHit: false, ragCacheHit: 'not_applicable', ragChunksReturned: 0, ragChunksInjected: 0, selectedAgents: [], inputTokens: 0, outputTokens: 0, totalTokens: 0, estimatedCostUsd: 0, creditsUsed: 0, aiDurationMs: null, timeToFirstTokenMs: null, provider: null, modelId: null, apiModelId: null, businessId: null, botId: null, sessionId: req.body?.sessionId || null, stepTimingsMs: {}, simpleIntent: null, replySource: null, aiSkipped: false, aiSkipReason: null, replyCacheHit: 'not_applicable', ragSkipped: false, ragSkipReason: null };

  // SECTION 1: Input validation
  let { botId, sessionId, message } = req.body;
  summary.botId = botId || null;
  if (!botId) return res.status(400).json({ error: 'botId required' });
  if (!sessionId) return res.status(400).json({ error: 'sessionId required' });
  if (!message) return res.status(400).json({ error: 'message required' });
  if (botId !== req.namespace) return res.status(403).json({ error: 'Invalid bot scope' });
  message = sanitizeMessage(message);
  if (message.length < 1) return res.status(400).json({ error: 'Message empty after sanitize' });

  // SECTION 2: Load config (Redis → DB)
  let config;
  perf.startTimer('bot_config_lookup');
  const redisBotKey = `chatbot_config:${req.namespace}`;
  try { const cached = await redisClient.get(redisBotKey); if (cached) config = JSON.parse(cached); summary.botConfigCacheHit = Boolean(cached); perf.log('bot_config_cache_lookup', { cacheKey: 'chatbot_config:<namespace>', botConfigCacheHit: summary.botConfigCacheHit }); } catch (e) { summary.botConfigCacheHit = 'error_fallback'; perf.error('redis_error', e, { operation: 'bot_config_lookup', fallback: 'db_lookup' }); }
  if (!config) {
    perf.startTimer('bot_config_db_lookup');
    const cfg = await pool.query(`SELECT bc.system_prompt, bc.selected_agents, bc.selected_model, bc.welcome_message, bc.starter_prompts, bc.is_draft, bc.detected_location, bc.detected_services, b.industry, b.business_name, b.owner_email, b.owner_phone, b.escalation_email, b.primary_color, b.calendly_link, b.availability_slots, b.bot_id, b.id as business_id, b.timezone, b.plan, b.is_disabled, b.disabled_reason FROM bot_configs bc JOIN businesses b ON bc.business_id = b.id WHERE b.bot_id=$1 AND bc.active=true LIMIT 1`, [botId]);
    if (!cfg.rows[0]) return res.status(404).json({ error: 'Bot not configured', message: 'Please complete onboarding first' });
    config = { ...cfg.rows[0], calendlyLink: cfg.rows[0].calendly_link, ownerPhone: cfg.rows[0].owner_phone };
    const dbMs = perf.endTimer('bot_config_db_lookup', { event: 'bot_config_db_lookup' });
    if (dbMs && dbMs > 500) perf.warn('slow_db_operation', { operation: 'bot_config_db_lookup', durationMs: dbMs });
    try { await redisClient.setex(redisBotKey, 3600, JSON.stringify(config)); } catch (e) { console.error(e.message); }
  }
  const cfgMs = perf.endTimer('bot_config_lookup', { botConfigCacheHit: summary.botConfigCacheHit });
  if (cfgMs != null) summary.stepTimingsMs.botConfigLookup = cfgMs;
  if (cfgMs && cfgMs > 300) perf.warn('slow_bot_config_fetch', { durationMs: cfgMs });
  if (!config?.business_id) return res.status(500).json({ error: 'Invalid bot config' });
  summary.businessId = config.business_id;
  perf.with({ businessId: config.business_id, botId });

  const deterministicLead = extractDeterministicLeadData(message);
  const leadSignalsDetected = Boolean(deterministicLead?.leadSignals?.length);
  perf.log('lead_pipeline_start', { requestId, businessId: config.business_id, botId, sessionId, leadExtractorEnabled: LEAD_EXTRACTOR_ENABLED });
  perf.log('lead_signal_detection_done', { requestId, businessId: config.business_id, botId, sessionId, leadSignalsDetected });
  perf.log('deterministic_lead_extraction_done', { requestId, businessId: config.business_id, botId, sessionId, deterministicLeadDetected: Boolean(deterministicLead?.extracted), deterministicConfidence: deterministicLead?.confidence || 0 });
  summary.leadExtractionAttempted = true;
  summary.leadSignalsDetected = leadSignalsDetected;
  summary.deterministicLeadDetected = Boolean(deterministicLead?.extracted);
  summary.deterministicLeadConfidence = deterministicLead?.confidence || 0;
  summary.leadExtractorEnabled = LEAD_EXTRACTOR_ENABLED;
  summary.leadExtractorCalled = false;
  summary.leadExtractorCacheHit = false;
  summary.leadExtractorModel = LEAD_EXTRACTOR_MODEL;
  summary.leadExtractorProvider = process.env.LEAD_EXTRACTOR_PROVIDER || 'openai';
  summary.leadExtractorFailed = false;
  summary.leadExtractorSkippedReason = null;
  summary.leadExtractorInputTokens = 0;
  summary.leadExtractorOutputTokens = 0;
  summary.leadExtractorCostUsd = 0;
  summary.leadExtractorFilledFields = [];
  summary.leadDedupStrategy = 'none';
  let leadToSave = deterministicLead?.extracted || null;
  let aiLead = null;
  const shouldCallLeadExtractor = LEAD_EXTRACTOR_ENABLED && shouldRunLeadAgent(message, deterministicLead);
  summary.leadExtractorCalled = shouldCallLeadExtractor;
  perf.log('lead_extractor_decision', { requestId, businessId: config.business_id, botId, sessionId, leadExtractorEnabled: LEAD_EXTRACTOR_ENABLED, leadExtractorCalled: shouldCallLeadExtractor, leadExtractorSkippedReason: shouldCallLeadExtractor ? null : (LEAD_EXTRACTOR_ENABLED ? 'no_signal_or_confident_deterministic' : 'disabled') });

  if (shouldCallLeadExtractor) {
    const normalizedMessage = normalizeMessageForCache(message);
    const cacheKey = `lead-extract:${config.business_id}:${sessionId}:${Buffer.from(normalizedMessage).toString('base64')}`;
    const provider = String(process.env.LEAD_EXTRACTOR_PROVIDER || 'openai').toLowerCase();
    const providerApiKey = provider === 'anthropic' ? process.env.ANTHROPIC_API_KEY : process.env.OPENAI_API_KEY;
    perf.log('lead_extractor_config', { requestId, businessId: config.business_id, botId, sessionId, LEAD_EXTRACTOR_ENABLED, leadExtractorProviderConfigured: Boolean(process.env.LEAD_EXTRACTOR_PROVIDER), leadExtractorModelConfigured: Boolean(LEAD_EXTRACTOR_MODEL), leadExtractorApiKeyPresent: Boolean(providerApiKey) });
    const cached = await redisClient.get(cacheKey).catch(() => null);
    if (cached) {
      summary.leadExtractorCacheHit = true;
      try { aiLead = JSON.parse(cached); } catch { aiLead = null; }
    } else if (!provider || !LEAD_EXTRACTOR_MODEL || !providerApiKey) {
      summary.leadExtractorSkippedReason = 'not_configured';
    } else {
      try {
        const openai = getOpenAIClient();
        if (!openai) throw new Error('lead_extractor_not_configured');
        const prompt = `Return strict JSON object only with fields: isLead, fullName, name, email, phone, companyName, company_name, churchName, location, serviceNeed, budgetRange, budget_range, timeline, leadScore, scoreReasons. Extract only from this message: ${message}`;
        const rsp = await withTimeout((signal) => openai.chat.completions.create({ model: LEAD_EXTRACTOR_MODEL, max_tokens: LEAD_EXTRACTOR_MAX_TOKENS, response_format: { type: 'json_object' }, messages: [{ role: 'system', content: 'You are a lead extraction agent. Output strict JSON only. No prose.' }, { role: 'user', content: prompt }], signal }), LEAD_EXTRACTOR_TIMEOUT_MS);
        aiLead = JSON.parse(rsp.choices?.[0]?.message?.content || '{}');
        summary.leadExtractorInputTokens = rsp?.usage?.prompt_tokens || 0;
        summary.leadExtractorOutputTokens = rsp?.usage?.completion_tokens || 0;
        summary.leadExtractorCostUsd = estimateCost(LEAD_EXTRACTOR_MODEL, summary.leadExtractorInputTokens, summary.leadExtractorOutputTokens);
      } catch (error) {
        summary.leadExtractorFailed = true;
        perf.error('lead_extractor_failed', error, { code: safeLeadExtractorErrorCode(error) });
      }
    }
  } else {
    summary.leadExtractorSkippedReason = LEAD_EXTRACTOR_ENABLED ? 'no_signal_or_confident_deterministic' : 'disabled';
  }

  if (aiLead?.isLead) {
    const before = leadToSave || {};
    leadToSave = mergeLeadData(leadToSave || {}, aiLead || {});
    summary.leadExtractorFilledFields = ['fullName', 'budgetRange', 'timeline', 'companyName', 'location', 'serviceNeed'].filter((f) => !before[f] && leadToSave[f]);
  }
  perf.log(aiLead?.isLead ? 'lead_extractor_done' : 'lead_extractor_skipped', { requestId, businessId: config.business_id, botId, sessionId, leadExtractorCalled: summary.leadExtractorCalled, leadExtractorSkippedReason: summary.leadExtractorSkippedReason, leadExtractorFailed: summary.leadExtractorFailed });

  summary.leadDataDetected = Boolean(leadToSave);
  if (leadToSave && hasMinimumLeadDataForSave(leadToSave)) {
    summary.leadSaveAttempted = true;
    perf.log('lead_save_start', { requestId, businessId: config.business_id, botId, sessionId, leadSaveAttempted: true });
    const leadResult = await saveLead(config, sessionId, leadToSave, req.namespace);
    summary.leadCaptureStatus = leadResult.status;
    summary.leadDedupStrategy = leadResult.status;
    summary.capturedFields = leadResult.capturedFields.filter((field) => ['name','fullName','email','phone','churchName','company_name','serviceNeed','location','budgetRange','timeline'].includes(field));
    perf.log('lead_save_done', { requestId, businessId: config.business_id, botId, sessionId, leadCaptureStatus: summary.leadCaptureStatus, capturedFields: summary.capturedFields });
  }
  perf.log('lead_pipeline_done', { requestId, businessId: config.business_id, botId, sessionId, leadSignalsDetected: summary.leadSignalsDetected, deterministicLeadDetected: summary.deterministicLeadDetected, deterministicConfidence: summary.deterministicLeadConfidence, leadExtractorEnabled: summary.leadExtractorEnabled, leadExtractorCalled: summary.leadExtractorCalled, leadExtractorSkippedReason: summary.leadExtractorSkippedReason, leadExtractorFailed: summary.leadExtractorFailed, leadDataDetected: summary.leadDataDetected, leadSaveAttempted: Boolean(summary.leadSaveAttempted), leadCaptureStatus: summary.leadCaptureStatus, capturedFields: summary.capturedFields });


  // SECTION 3: is_disabled check
  if (config.is_disabled) {
    const disabledMsg = config.disabled_reason ||
      'This chatbot is temporarily unavailable. Please contact the business directly.';

    if (isStreaming) {
      perf.startTimer('ai_call');
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('X-Accel-Buffering', 'no');

      res.write('data: {"type":"ready"}\n\n');
      res.write('data: ' + JSON.stringify({ text: disabledMsg, token: disabledMsg }) + '\n\n');
      res.write('data: ' + JSON.stringify({ type: 'meta', reply: disabledMsg, isDisabled: true }) + '\n\n');
      res.write('data: [DONE]\n\n');
      res.end();
    } else {
      res.json({ reply: disabledMsg, isDisabled: true });
    }
    return;
  }

  // SECTION 4: Healthcare triage
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
      perf.startTimer('ai_call');
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('X-Accel-Buffering', 'no');
      res.write('data: {"type":"ready"}\n\n');
      res.write(`data: ${JSON.stringify({ text: triageText, token: triageText })}\n\n`);
      res.write(`data: ${JSON.stringify({ type: 'meta', reply: triageText })}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
    } else {
      res.json({ reply: triageText });
    }
    return;
  }

  // SECTION 5: Escalation keyword check
  const escalationDetected = ['speak to someone', 'speak to a person', 'call me', 'real person', 'human agent', 'talk to someone', 'complaint', 'legal action', 'urgent help', 'want to speak'].some((kw) => message.toLowerCase().includes(kw));
  // SECTION 6: Load session + history
  perf.startTimer('session_history_load');
  let session = (await pool.query('SELECT * FROM sessions WHERE id=$1', [sessionId])).rows[0] || null;
  if (!session) { await pool.query("INSERT INTO sessions (id,business_id,current_phase,collected_data,status,started_at,last_activity_at) VALUES ($1,$2,1,'{}','active',NOW(),NOW()) ON CONFLICT (id) DO NOTHING", [sessionId, config.business_id]); session = { current_phase: 1 }; }
  const historyRows = await pool.query('SELECT role, content FROM messages WHERE session_id=$1 ORDER BY created_at DESC LIMIT 20', [sessionId]);
  const sessionHistoryMs = perf.endTimer('session_history_load', { historyCount: historyRows.rows.length });
  if (sessionHistoryMs != null) summary.stepTimingsMs.sessionHistoryLoad = sessionHistoryMs;

  // SMART HISTORY PRUNING — keep last 6 full messages, summarize older ones
  const MAX_FULL_MSG = 6;
  const MAX_SUMMARY_MSG = 6;
  const processedMessages = [];
  let fullCount = 0;
  let summaryCount = 0;

  // historyRows.rows is sorted by created_at DESC (most recent first)
  for (const msg of historyRows.rows) {
    if (fullCount < MAX_FULL_MSG) {
      processedMessages.unshift({ role: msg.role, content: msg.content });
      fullCount++;
    } else if (summaryCount < MAX_SUMMARY_MSG) {
      processedMessages.unshift({
        role: 'system',
        content: `Previous conversation: ${msg.role === 'user' ? 'User asked' : 'Assistant said'}: "${msg.content.slice(0, 120)}"...`
      });
      summaryCount++;
    } else {
      break; // drop older messages
    }
  }
  const simpleIntent = detectSimpleIntent(message);
  summary.simpleIntent = simpleIntent;
  const selectedAgents = Array.isArray(config.selected_agents) ? config.selected_agents : [];
  summary.selectedAgents = selectedAgents;
  if (simpleIntent) {
    const quickReply = buildSimpleReply(simpleIntent, config) || 'Hi! How can I help today?';
    summary.replySource = 'saved_simple_reply';
    summary.aiSkipped = true;
    summary.aiSkipReason = 'saved_simple_reply';
    summary.ragSkipped = true;
    summary.ragSkipReason = 'simple_intent';
    summary.ragChunksReturned = 0;
    summary.ragChunksInjected = 0;
    summary.stepTimingsMs.ragSearch = 0;
    summary.status = 'success';
    const resolvedModel = { modelId: config.selected_model || process.env.DEFAULT_CHAT_MODEL || 'gpt-4o-mini' };
    const usage = { ...ZERO_USAGE };
    return res.json({ reply: quickReply, source: 'saved_simple_reply', resolvedModel, agentsUsed: selectedAgents, usage });
  }

  // SECTION 7: RAG context retrieval
  let chunks = [];
  const normalizedMessage = normalizeMessageForCache(message);
  const commonIntent = detectIntentCategory(normalizedMessage);
  const commonConfigAnswerable = ['services', 'booking', 'location'].includes(commonIntent);
  const embeddingsUnavailable = await redisClient.get('embeddings:provider_unavailable').catch(() => null);
  const ragEligible = message.trim().length > 2 && !commonConfigAnswerable && !embeddingsUnavailable;
  if (!ragEligible) {
    summary.ragSkipped = true;
    summary.ragSkipReason = commonConfigAnswerable ? 'common_intent_config_answerable' : (embeddingsUnavailable ? 'embedding_provider_unavailable_cached' : 'message_too_short');
    summary.ragCacheHit = 'not_applicable';
    summary.ragChunksReturned = 0;
    summary.ragChunksInjected = 0;
  }
  perf.startTimer('rag_search');
  try {
    if (ragEligible) {
      chunks = await getRelevantChunks(config.business_id, message, req.namespace, 5, {
        onCacheStatus: (status) => { summary.ragCacheHit = status; }
      });
      if (summary.ragCacheHit === 'not_applicable') summary.ragCacheHit = false;
      summary.ragChunksReturned = chunks.length;
    } else {
      summary.ragCacheHit = 'not_applicable';
    }
  } catch (ragError) {
    perf.error('rag_retrieval_error', ragError, { fallback: 'continue_without_rag' });
    chunks = [];
    if (summary.ragCacheHit === 'not_applicable') summary.ragCacheHit = 'error_fallback';
  }
  const ragMs = perf.endTimer('rag_search', { ragChunksReturned: chunks.length });
  if (ragMs != null && !summary.ragSkipped) summary.stepTimingsMs.ragSearch = ragMs;
  if (summary.ragSkipped) summary.stepTimingsMs.ragSearch = 0;
  if (ragMs && ragMs > 800) perf.warn('slow_pgvector_search', { durationMs: ragMs });
  const contextText = chunks.length > 0 ? chunks.map((c) => c.content).join('\n\n') : '';
  summary.ragChunksInjected = chunks.length;
  perf.log('rag_context_stats', { ragChunksReturned: chunks.length, ragChunksInjected: chunks.length, ragContextChars: contextText.length });

  // SECTION 8: Build system prompt
  const businessInfo = {
    industry: config.industry,
    businessName: config.business_name,
    primaryServices: Array.isArray(config.detected_services) ? config.detected_services : [],
    location: config.detected_location || '',
    ownerPhone: config.owner_phone || '',
    calendlyLink: config.calendly_link || null
  };

  const availability = config.availability_slots || {};

  perf.startTimer('prompt_build');
  const { prompt: builtPrompt, usedAgents } = selectedAgents.length > 0
    ? buildMasterPrompt(businessInfo, selectedAgents, availability)
    : { prompt: '', usedAgents: [] };
  const agentSystemPrompt = config.system_prompt || builtPrompt;

  const ragBlock = contextText && contextText.length > 0
    ? 'KNOWLEDGE BASE:\n' + contextText + '\nUse this to answer accurately.\n\n'
    : '';

  const phaseBlock = '\nCURRENT PHASE: ' + (session?.current_phase || 1) + '\n';

  const promptMs = perf.endTimer('prompt_build', { selectedAgents: usedAgents, promptChars: (ragBlock + agentSystemPrompt + phaseBlock).length });
  if (promptMs != null) summary.stepTimingsMs.promptBuild = promptMs;
  if (promptMs && promptMs > 300) perf.warn('slow_prompt_build', { durationMs: promptMs });
  perf.log('prompt_features', { hasBusinessProfile: true, hasRagContext: Boolean(contextText), hasSelectedAgentInstructions: usedAgents.length > 0, hasLeadCaptureInstructions: /LEAD_DATA/.test(agentSystemPrompt), hasBookingDiscoveryInstructions: /book|discovery|appointment/i.test(agentSystemPrompt), selectedAgentsCount: usedAgents.length, selectedAgents: usedAgents });
  summary.selectedAgents = usedAgents;
  const fullSystemPrompt = ragBlock + agentSystemPrompt + phaseBlock;
  const messagesArray = [...processedMessages, { role: 'user', content: message }];
  const brevityPrompt = '\nRESPONSE STYLE:\nKeep responses concise and natural. Target 80-140 words (40-90 for simple asks). Ask at most 1-2 questions. Avoid repeating long service lists. Use minimal emojis. Suggest booking only for buying/pricing/complex intent.\n';
  const finalSystemPrompt = fullSystemPrompt + brevityPrompt;

  const shouldCacheAiReply = (() => {
    if (!['services', 'pricing', 'support', 'booking'].includes(commonIntent)) return false;
    if (normalizedMessage.length > 180) return false;
    if (/\b(email|phone|my name is|i am |budget|\$|\d{3}[-.\s]?\d{3}[-.\s]?\d{4}|@)\b/i.test(message)) return false;
    if (/\b(ignore previous|system prompt|jailbreak|override|emergency|medical|legal)\b/i.test(message)) return false;
    return true;
  })();
  const botConfigVersion = String(config.updated_at || config.business_id || 'v1');
  const cacheHash = Buffer.from(normalizedMessage).toString('base64url').slice(0, 24);
  const aiCacheKey = `chat:reply-cache:${config.business_id}:${commonIntent}:${cacheHash}:${botConfigVersion}`;

  // SECTION 9: callWithFallback
  const callWithFallback = async (stream, config, systemPrompt, messages) => {
    const requestedModel = config.selected_model || process.env.DEFAULT_CHAT_MODEL || 'gpt-4o-mini';
    const latestUserMessage = messages?.[messages.length - 1]?.content || '';
    const isComplexAsk = latestUserMessage.length > 320 || /\b(compare|comparison|detailed|step by step|proposal|plan|requirements)\b/i.test(latestUserMessage);
    const maxTokens = isComplexAsk ? 500 : 320;

    // Resolve model — enforces plan, reads from DB
    // resolvedModel is LOCAL to this function call
    const resolvedModel = await getSafeModel(requestedModel);
    perf.log('model_resolved', { requestedModelId: requestedModel, modelId: resolvedModel.modelId, apiModelId: resolvedModel.apiModelId, provider: resolvedModel.provider, wasDowngraded: resolvedModel.wasDowngraded });
    summary.provider = resolvedModel.provider; summary.modelId = resolvedModel.modelId; summary.apiModelId = resolvedModel.apiModelId;

    console.log('[chat] Model resolved', {
      businessId: config.business_id,
      plan: config.plan,
      requested: config.selected_model,
      using: resolvedModel.modelId,
      provider: resolvedModel.provider,
      wasDowngraded: resolvedModel.wasDowngraded
    });

    // ── Anthropic provider ──────────────────────
    if (resolvedModel.provider === 'anthropic') {
      const anthropicModel = (typeof resolvedModel.apiModelId === 'string' && resolvedModel.apiModelId.startsWith('claude-'))
        ? resolvedModel.apiModelId
        : DEFAULT_ANTHROPIC_MODEL;

      console.log('[debug model] resolvedModel:', resolvedModel);
      console.log('[debug model] selectedModel:', config.selected_model);
      console.log('[debug model] raw requested model:', requestedModel);
      console.log('[debug model] anthropicModel before final call:', anthropicModel);

      if (anthropicModel !== resolvedModel.apiModelId) {
        console.warn('[chat] Invalid or missing Anthropic model, applying safe default', {
          requested: config.selected_model,
          resolvedApiModelId: resolvedModel.apiModelId,
          fallbackApiModelId: anthropicModel
        });
      }

      if (stream) {
        const anthropic = getAnthropicClient();
        if (!anthropic) throw new Error('Missing ANTHROPIC_API_KEY');
        const anthropicPayload = buildAnthropicPayload(systemPrompt, messages);
        console.log('[chat] provider_call_debug', {
          provider: resolvedModel.provider,
          apiModelId: anthropicModel,
          hasSystem: Boolean(anthropicPayload.system),
          systemChars: anthropicPayload.system.length,
          messagesCount: anthropicPayload.messages.length,
          messageRoles: anthropicPayload.messages.map((m) => m.role)
        });
        console.log('[anthropic] final model sent:', anthropicModel);
        const anthropicStream = await anthropic.messages.stream({
          model: anthropicModel,
          max_tokens: maxTokens,
          system: anthropicPayload.system,
          messages: anthropicPayload.messages
        });
        return { stream: anthropicStream, resolvedModel };
      }

      // Non-streaming with OpenAI fallback
      try {
        const anthropic = getAnthropicClient();
        if (!anthropic) throw new Error('Missing ANTHROPIC_API_KEY');
        const anthropicPayload = buildAnthropicPayload(systemPrompt, messages);
        console.log('[chat] provider_call_debug', {
          provider: resolvedModel.provider,
          apiModelId: anthropicModel,
          hasSystem: Boolean(anthropicPayload.system),
          systemChars: anthropicPayload.system.length,
          messagesCount: anthropicPayload.messages.length,
          messageRoles: anthropicPayload.messages.map((m) => m.role)
        });
        console.log('[anthropic] final model sent:', anthropicModel);
        const response = await anthropic.messages.create({
          model: anthropicModel,
          max_tokens: maxTokens,
          system: anthropicPayload.system,
          messages: anthropicPayload.messages
        });
        return {
          reply: response.content[0].text,
          resolvedModel,
          usage: buildUsageSummary(response.usage, resolvedModel.modelId)
        };
      } catch (anthropicErr) {
        console.error('[chat] Anthropic request failed:', {
          message: anthropicErr?.message || 'unknown_error',
          status: anthropicErr?.status,
          type: anthropicErr?.error?.type
        });
        const openai = getOpenAIClient();
        if (!openai) throw anthropicErr;
        try {
          const fb = await openai.chat.completions.create({
          model: process.env.OPENAI_FALLBACK_MODEL || 'gpt-4o-mini',
          max_tokens: maxTokens,
          messages: [
            { role: 'system', content: systemPrompt },
            ...messages
          ]
        });
          return {
            reply: fb.choices[0].message.content,
            resolvedModel: { ...resolvedModel, wasDowngraded: true },
            usage: DEFAULT_USAGE
          };
        } catch (openaiFallbackErr) {
          console.error('[chat] OpenAI fallback failed:', openaiFallbackErr.message);
          throw openaiFallbackErr;
        }
      }
    }

    // ── OpenAI provider ─────────────────────────
    if (resolvedModel.provider === 'openai') {
      const openaiMessages = [
        { role: 'system', content: systemPrompt },
        ...messages
      ];

      if (stream) {
        const openai = getOpenAIClient();
        if (!openai) throw new Error('Missing OPENAI_API_KEY');
        const openaiStream = await openai.chat.completions.create({
          model: resolvedModel.apiModelId,
          max_tokens: maxTokens,
          stream: true,
          messages: openaiMessages
        });

        // Wrap to match Anthropic stream interface
        const wrappedStream = {
          [Symbol.asyncIterator]: async function* () {
            for await (const chunk of openaiStream) {
              const text = chunk.choices[0]?.delta?.content;
              if (text) {
                yield {
                  type: 'content_block_delta',
                  delta: { type: 'text_delta', text }
                };
              }
            }
          }
        };
        return { stream: wrappedStream, resolvedModel };
      }

      const openai = getOpenAIClient();
      if (!openai) throw new Error('Missing OPENAI_API_KEY');
      const response = await openai.chat.completions.create({
        model: resolvedModel.apiModelId,
        max_tokens: maxTokens,
        messages: openaiMessages
      });
      return {
        reply: response.choices[0].message.content,
        resolvedModel,
        usage: DEFAULT_USAGE
      };
    }

    throw new Error('[chat] Unknown provider: ' + resolvedModel.provider);
  };


function parseLeadDataFromResponse(fullResponse) {
  const leadMatch = fullResponse.match(/LEAD_DATA:\s*({[\s\S]*?})\s*(?:\n|$)/);
  if (!leadMatch) return null;
  try {
    return JSON.parse(leadMatch[1]);
  } catch (error) {
    console.warn('LEAD_DATA parse failed, attempting recovery:', error.message);
    const emailMatch = fullResponse.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
    const phoneMatch = fullResponse.match(/(?:\+?\d[\d\s().-]{7,}\d)/);
    if (!emailMatch && !phoneMatch) return null;
    return {
      email: emailMatch?.[0] || null,
      phone: phoneMatch?.[0] || null,
      lead_score: 'warm',
      score_reasons: ['partial_contact_detected']
    };
  }
}

function normalizeLeadData(leadData, messageText = '') {
  if (!leadData || typeof leadData !== 'object') return null;
  const normalized = { ...leadData };
  if (!normalized.lead_score) {
    const text = `${messageText} ${JSON.stringify(leadData)}`.toLowerCase();
    normalized.lead_score = /(urgent|asap|today|immediately)/.test(text) ? 'hot' : /(budget|quote|book|schedule)/.test(text) ? 'warm' : 'cold';
    normalized.score_reasons = [...(Array.isArray(normalized.score_reasons) ? normalized.score_reasons : []), 'backend_default_score'];
  }
  return normalized;
}

function cleanAssistantResponse(text = '') {
  return String(text)
    .replace(/CALENDLY_BUTTON:\S+/g, '')
    .replace(/PHASE_\d+_COMPLETE/g, '')
    .replace(/LEAD_DATA:\s*({[\s\S]*?})\s*(?:\n|$)/g, '')
    .replace(/ESCALATION_REQUIRED/g, '')
    .replace(/URGENT_ESCALATION/g, '')
    .trim();
}

  // SECTION 11: Save async
  const processResponse = async (fullResponse, result) => {
    const tasks = [];
    // Analytics fields (lightweight, fire-and-forget)
    const intentCategory = detectIntentCategory(message);
    const isUnanswered = checkIfUnanswered(fullResponse, contextText);
    const fallbackUsed = result.resolvedModel.wasDowngraded || (selectedAgents.length === 0 && config.system_prompt);
    const userMsgLen = message.length;
    const aiRespLen = fullResponse.length;

    tasks.push(
      pool.query(
        `INSERT INTO messages (session_id,business_id,role,content,agent_phase,model_used,intent_category,is_unanswered,fallback_used,user_message_length,ai_response_length,created_at)
         VALUES ($1,$2,'user',$3,$4,null,$5,false,$6,$7,null,NOW())`,
        [sessionId, config.business_id, message, session?.current_phase || 1, intentCategory, fallbackUsed, userMsgLen]
      ),
      pool.query(
        `INSERT INTO messages (session_id,business_id,role,content,agent_phase,model_used,intent_category,is_unanswered,fallback_used,user_message_length,ai_response_length,created_at)
         VALUES ($1,$2,'assistant',$3,$4,$5,null,$6,$7,null,$8,NOW())`,
        [sessionId, config.business_id, fullResponse, session?.current_phase || 1, result.resolvedModel.apiModelId, isUnanswered, fallbackUsed, aiRespLen]
      )
    );
    tasks.push((async () => { const phaseMatch = fullResponse.match(/PHASE_(\d+)_COMPLETE/); if (phaseMatch) await pool.query('UPDATE sessions SET current_phase=$1,last_activity_at=NOW() WHERE id=$2', [Number.parseInt(phaseMatch[1], 10) + 1, sessionId]); else await pool.query('UPDATE sessions SET last_activity_at=NOW() WHERE id=$1', [sessionId]); })());
    tasks.push((async () => { if (fullResponse.includes('ESCALATION_REQUIRED') || escalationDetected) { await pool.query("UPDATE sessions SET status = 'escalated' WHERE id=$1", [sessionId]); sendUrgentEscalation(config, sessionId, message).catch((e) => console.error(e.message)); } })());
    tasks.push((async () => { const parsedLead = parseLeadDataFromResponse(fullResponse); const leadData = normalizeLeadData(parsedLead, message); if (leadData && (leadData.email || leadData.phone || leadData.name)) { const leadResult = await saveLead(config, sessionId, leadData, req.namespace); summary.leadDataDetected = true; summary.leadCaptureStatus = leadResult.status; summary.capturedFields = Array.from(new Set([...(summary.capturedFields || []), ...leadResult.capturedFields])); } })());
    await Promise.allSettled(tasks);
  };

  // SECTION 10: Stream/send response
  if (isStreaming) {
    res.setHeader('Content-Type', 'text/event-stream'); res.setHeader('Cache-Control', 'no-cache'); res.setHeader('Connection', 'keep-alive'); res.setHeader('X-Accel-Buffering', 'no');
    res.write('data: {"type":"ready"}\n\n');
    const keepAlive = setInterval(() => res.write(': keep-alive\n\n'), 15000);
    const timeout = setTimeout(() => { clearInterval(keepAlive); res.write('data: [DONE]\n\n'); res.end(); }, 30000);
    let fullResponse = ''; let calendlyUrl = null;
    let streamUsage = { input_tokens: 0, output_tokens: 0 };
    try {
      perf.log('ai_call_start', { provider: summary.provider, modelId: summary.modelId, apiModelId: summary.apiModelId });
      const result = await callWithFallback(true, config, finalSystemPrompt, messagesArray);
      const stream = result.stream;
      // result.resolvedModel will be used later in the meta frame
      let firstTokenSent = false;
      for await (const chunk of stream) {
        if (chunk?.type === 'message_start' && chunk?.message?.usage) {
          streamUsage.input_tokens = Number.isFinite(chunk.message.usage.input_tokens) ? chunk.message.usage.input_tokens : streamUsage.input_tokens;
          streamUsage.output_tokens = Number.isFinite(chunk.message.usage.output_tokens) ? chunk.message.usage.output_tokens : streamUsage.output_tokens;
        }
        if (chunk?.type === 'message_delta' && chunk?.usage) {
          if (Number.isFinite(chunk.usage.input_tokens)) streamUsage.input_tokens = chunk.usage.input_tokens;
          if (Number.isFinite(chunk.usage.output_tokens)) streamUsage.output_tokens = chunk.usage.output_tokens;
        }
        if (chunk.type === 'content_block_delta' && chunk.delta?.type === 'text_delta') {
          const token = chunk.delta.text; fullResponse += token;
          if (!firstTokenSent) { firstTokenSent = true; summary.timeToFirstTokenMs = Number((performance.now() - requestStart).toFixed(2)); perf.log('ai_first_token', { timeToFirstTokenMs: summary.timeToFirstTokenMs }); if (summary.timeToFirstTokenMs > 2500) perf.warn('slow_first_token', { timeToFirstTokenMs: summary.timeToFirstTokenMs }); }
          res.write(`data: ${JSON.stringify({ text: token, token })}\n\n`);
        }
      }
      clearInterval(keepAlive); clearTimeout(timeout);
      const calendlyMatch = fullResponse.match(/CALENDLY_BUTTON:(\S+)/); if (calendlyMatch) calendlyUrl = calendlyMatch[1];
      if (calendlyUrl) res.write(`data: ${JSON.stringify({ type: 'calendly_button', url: calendlyUrl, label: 'Book Your Appointment →' })}\n\n`);
      const usage = buildUsageSummary(streamUsage, result.resolvedModel.modelId);
      summary.inputTokens = usage.inputTokens; summary.outputTokens = usage.outputTokens; summary.totalTokens = usage.inputTokens + usage.outputTokens; summary.estimatedCostUsd = usage.estimatedCostUsd; summary.creditsUsed = usage.creditsUsed; summary.aiDurationMs = perf.endTimer('ai_call', { event: 'ai_call_done', provider: result.resolvedModel.provider, modelId: result.resolvedModel.modelId, apiModelId: result.resolvedModel.apiModelId, inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, totalTokens: usage.inputTokens + usage.outputTokens, estimatedCostUsd: usage.estimatedCostUsd, creditsUsed: usage.creditsUsed, timeToFirstTokenMs: summary.timeToFirstTokenMs });
      if (summary.aiDurationMs != null) summary.stepTimingsMs.aiCall = summary.aiDurationMs;
      if (summary.aiDurationMs && summary.aiDurationMs > 4000) perf.warn('slow_ai_call', { durationMs: summary.aiDurationMs });
      const cleanResponse = cleanAssistantResponse(fullResponse);
      res.write(`data: ${JSON.stringify({ type: 'meta', reply: cleanResponse, model: result.resolvedModel.modelId, wasDowngraded: result.resolvedModel.wasDowngraded, agentsUsed: usedAgents, usage })}\n\n`);
      res.write('data: [DONE]\n\n'); res.end();
      processResponse(fullResponse, result).catch((e) => perf.error('process_response_error', e));
      summary.status = 'success';
    } catch (streamError) {
      clearInterval(keepAlive); clearTimeout(timeout);
      summary.errorStage = summary.errorStage || 'streaming_response';
      if (!res.writableEnded) {
        res.write(`data: ${JSON.stringify({ type: 'error', message: 'Something went wrong. Please try again.' })}\n\n`); res.write('data: [DONE]\n\n'); res.end();
      }
    }
    return;
  }

  try {
    perf.startTimer('ai_call');
    perf.log('ai_call_start', { provider: summary.provider, modelId: summary.modelId, apiModelId: summary.apiModelId });
    if (shouldCacheAiReply) {
      const cachedReply = await redisClient.get(aiCacheKey).catch(() => null);
      if (cachedReply) {
        summary.replyCacheHit = true;
        summary.replySource = 'redis_cached_ai_reply';
        summary.aiSkipped = true;
        summary.aiSkipReason = 'redis_cached_ai_reply';
        summary.status = 'success';
        return res.json({ reply: cachedReply, source: 'redis_cached_ai_reply', resolvedModel: { modelId: config.selected_model || process.env.DEFAULT_CHAT_MODEL || 'gpt-4o-mini' }, agentsUsed: usedAgents, usage: { ...ZERO_USAGE } });
      }
      summary.replyCacheHit = false;
    }
    const result = await callWithFallback(false, config, finalSystemPrompt, messagesArray);
    const fullResponse = result.reply;
    // result.resolvedModel will be used later
    const cleanResponse = cleanAssistantResponse(fullResponse);
    summary.inputTokens = result.usage?.inputTokens || 0; summary.outputTokens = result.usage?.outputTokens || 0; summary.totalTokens = summary.inputTokens + summary.outputTokens; summary.estimatedCostUsd = result.usage?.estimatedCostUsd || 0; summary.creditsUsed = result.usage?.creditsUsed || 0;
    summary.aiDurationMs = perf.endTimer('ai_call', { event: 'ai_call_done', provider: result.resolvedModel.provider, modelId: result.resolvedModel.modelId, apiModelId: result.resolvedModel.apiModelId, inputTokens: summary.inputTokens, outputTokens: summary.outputTokens, totalTokens: summary.totalTokens, estimatedCostUsd: summary.estimatedCostUsd, creditsUsed: summary.creditsUsed });
    if (summary.aiDurationMs != null) summary.stepTimingsMs.aiCall = summary.aiDurationMs;
    if (summary.aiDurationMs && summary.aiDurationMs > 4000) perf.warn('slow_ai_call', { durationMs: summary.aiDurationMs });
    res.json({
      reply: cleanResponse,
      resolvedModel: result.resolvedModel,
      agentsUsed: usedAgents,
      usage: result.usage || DEFAULT_USAGE
    });
    if (shouldCacheAiReply && cleanResponse) {
      await redisClient.setex(aiCacheKey, 86400, cleanResponse).catch(() => null);
      summary.replySource = 'ai_generated_cached';
    } else {
      summary.replySource = 'ai_generated';
    }
    processResponse(fullResponse, result).catch((e) => perf.error('process_response_error', e));
    summary.status = 'success';
  } catch (error) {
    perf.error('chat_request_error', error);
    summary.errorStage = summary.errorStage || 'chat_response';
    if (!res.headersSent && !res.writableEnded) res.status(500).json({ error: 'Something went wrong. Please try again.' });
  } finally {
    const totalDurationMs = Number((performance.now() - requestStart).toFixed(2));
    const nonAiDurationMs = summary.aiDurationMs != null ? Number((totalDurationMs - summary.aiDurationMs).toFixed(2)) : null;
    summary.stepTimingsMs.total = totalDurationMs;
    summary.stepTimingsMs.nonAi = nonAiDurationMs;
    if (totalDurationMs > 1000) perf.warn('slow_backend_non_ai', { totalDurationMs, nonAiDurationMs });
    if (totalDurationMs > 5000) perf.warn('slow_chat_request', { totalDurationMs });
    perf.log('chat_request_summary', { ...summary, totalDurationMs, nonAiDurationMs }, true);
  }
});

export default router;
