import pool from '../db/pool.js';
import { redisClient } from './redis.js';
import { sendInquiryAlert } from './emailService.js';

const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;
const PHONE_RE = /(?:\+?\d[\d\s().-]{7,}\d)/;
const SIMPLE_VISITOR_MESSAGE_RE = /^(hi|hello|hey|hiya|yo|salam|assalam o alaikum|assalamu alaikum|good morning|good afternoon|good evening|test|testing|ok|okay|yes|no|thanks|thank you|thx|help)$/i;
const GENERIC_INQUIRY_SUMMARY_RE = /\b(greet|greeting|hello|visitor said hello|visitor greeted|simple greeting|general inquiry|general enquiry|website visitor sent a general inquiry|asked how.*help|how can i help)\b/i;
const LOW_DETAIL_INQUIRY_TEXT_RE = /^(complaint|i have a complaint|issue|problem|support|i need help|please contact me|contact me|call me|email me|speak to someone|speak to a person|human|real person|i want to speak to someone|i want to speak to the owner|i want to talk to manager)$/i;
const ACTIONABLE_INQUIRY_TYPES = new Set(['support', 'complaint', 'human_handoff', 'partnership', 'career', 'supplier', 'billing', 'technical_support']);
const OWNER_ACTION_RE = /\b(complaint|complain|not happy|refund|problem|issue|support|existing customer|billing|invoice|payment|call me|contact me|email me|reach me|get back to me|get in touch|speak to owner|talk to owner|speak to manager|talk to manager|speak to someone|speak to a person|human|real person|human agent|someone call|someone contact|follow up|partnership|partner|supplier|vendor|career|job)\b/i;

const INQUIRY_TYPE_ALIASES = {
  support: 'support',
  help: 'support',
  issue: 'support',
  problem: 'support',
  complaint: 'complaint',
  complain: 'complaint',
  human: 'human_handoff',
  human_handoff: 'human_handoff',
  callback: 'human_handoff',
  partnership: 'partnership',
  partner: 'partnership',
  career: 'career',
  job: 'career',
  supplier: 'supplier',
  billing: 'billing',
  invoice: 'billing',
  technical: 'technical_support',
  technical_support: 'technical_support',
  question: 'general',
  general: 'general',
  other: 'other',
};

const STRONG_INQUIRY_RE = /\b(contact me|call me|email me|support|complaint|complain|issue|problem|not happy|refund|speak to someone|speak to a person|speak to owner|speak to manager|human|real person|human agent|partnership|partner|career|job|supplier|billing|invoice|existing customer)\b/i;
const STRONG_SALES_RE = /\b(quote|estimate|pricing|price|demo|book a demo|book a call|consultation|appointment|viewing|buy|hire|project|website|crm|chatbot|software|renovation|construction work)\b/i;
const URGENCY_RE = /\b(urgent|asap|emergency|immediately|today|legal action|not happy|complaint)\b/i;

function cleanValue(value) {
  if (value === undefined || value === null) return null;
  const text = String(value).trim();
  if (!text || ['unknown', 'not specified', 'n/a', 'null', 'undefined'].includes(text.toLowerCase())) return null;
  return text;
}

function safeJsonParse(value, fallback = null) {
  if (!value) return fallback;
  if (typeof value === 'object') return value;
  try { return JSON.parse(value); } catch { return fallback; }
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

function getJsonCandidates(text = '') {
  return findBalancedJsonObjects(text)
    .map((raw) => ({ raw, parsed: tryParseJsonObject(raw) }))
    .filter((item) => item.parsed);
}

function normalizeInquiryType(value, fallbackText = '') {
  const raw = cleanValue(value) || '';
  const key = raw.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  if (INQUIRY_TYPE_ALIASES[key]) return INQUIRY_TYPE_ALIASES[key];

  const source = `${raw} ${fallbackText}`.toLowerCase();
  if (/complaint|not happy|legal action/.test(source)) return 'complaint';
  if (/support|help|issue|problem|existing customer/.test(source)) return 'support';
  if (/human|real person|speak to|call me/.test(source)) return 'human_handoff';
  if (/partner|partnership/.test(source)) return 'partnership';
  if (/career|job|hiring/.test(source)) return 'career';
  if (/supplier|vendor/.test(source)) return 'supplier';
  if (/billing|invoice|payment/.test(source)) return 'billing';
  return 'general';
}

function normalizePriority(value, urgencyFlag, type) {
  const raw = String(value || '').toLowerCase();
  if (['high', 'urgent'].includes(raw) || urgencyFlag || ['complaint', 'human_handoff'].includes(type)) return 'high';
  if (['low', 'normal', 'medium'].includes(raw)) return raw === 'medium' ? 'normal' : raw;
  return 'normal';
}

function normalizeBoolean(value) {
  if (typeof value === 'boolean') return value;
  const text = String(value || '').toLowerCase().trim();
  if (['yes', 'true', 'existing', 'current customer', 'current client'].includes(text)) return true;
  if (['no', 'false', 'new customer', 'new client'].includes(text)) return false;
  return false;
}

function looksLikeInquiryData(data = {}) {
  const keys = Object.keys(data || {}).map((key) => key.toLowerCase());
  return [
    'inquiry_type',
    'contact_reason',
    'message_summary',
    'contact_name',
    'contact_email',
    'contact_phone',
    'preferred_contact_method',
    'department_or_route',
    'existing_customer',
  ].some((key) => keys.includes(key));
}

function extractInquiryDataFromResponse(fullResponse = '') {
  const text = String(fullResponse || '');
  const markerMatch = text.match(/INQUIRY_DATA:\s*({[\s\S]*})/);
  if (markerMatch) {
    const markerCandidates = getJsonCandidates(markerMatch[1]);
    const markedInquiry = markerCandidates.find((item) => looksLikeInquiryData(item.parsed)) || markerCandidates[0];
    if (markedInquiry) return markedInquiry.parsed;
  }

  const candidates = getJsonCandidates(text).filter((item) => looksLikeInquiryData(item.parsed));
  if (!candidates.length) return null;
  return candidates[candidates.length - 1].parsed;
}

function mergeData(...profiles) {
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

function buildInquirySummary(inquiryData = {}) {
  const pieces = [
    inquiryData.contact_reason,
    inquiryData.message_summary,
    inquiryData.department_or_route ? `Route: ${inquiryData.department_or_route}` : null,
    inquiryData.existing_customer ? 'Existing customer' : null,
  ].filter(Boolean);
  return pieces.join(' | ') || 'Website visitor sent a general inquiry.';
}

function normalizeInquiryData(rawData = {}, transcript = '', config = {}) {
  const data = rawData || {};
  const text = String(transcript || '');
  const sourceText = `${JSON.stringify(data)}\n${text}`;
  const type = normalizeInquiryType(data.inquiry_type || data.contact_reason || data.department_or_route, sourceText);
  const urgencyFlag = Boolean(data.urgency_flag) || URGENCY_RE.test(sourceText);
  const agentsUsed = Array.isArray(data.agents_used)
    ? data.agents_used
    : Array.isArray(config.selected_agents)
      ? config.selected_agents.filter((agent) => agent === 'general_contact_router')
      : [];

  const normalized = {
    inquiry_type: type,
    status: cleanValue(data.status) || 'new',
    priority: normalizePriority(data.priority, urgencyFlag, type),
    full_name: cleanValue(data.full_name || data.fullName || data.name || data.contact_name),
    phone: cleanValue(data.phone || data.phone_number || data.phoneNumber || data.contact_phone),
    email: cleanValue(data.email || data.email_address || data.emailAddress || data.contact_email),
    company_name: cleanValue(data.company_name || data.companyName || data.organisation || data.organization),
    preferred_contact_method: cleanValue(data.preferred_contact_method || data.contact_method),
    contact_reason: cleanValue(data.contact_reason || data.reason || data.subject),
    message_summary: cleanValue(data.message_summary || data.summary || data.message || data.needs),
    department_or_route: cleanValue(data.department_or_route || data.department || data.route_to),
    existing_customer: normalizeBoolean(data.existing_customer),
    urgency_flag: urgencyFlag,
    urgency_reason: cleanValue(data.urgency_reason),
    agents_used: agentsUsed,
    raw_data: { ...data },
  };

  normalized.email = normalized.email || text.match(EMAIL_RE)?.[0] || null;
  normalized.phone = normalized.phone || text.match(PHONE_RE)?.[0]?.trim() || null;
  normalized.ai_summary = cleanValue(data.ai_summary) || buildInquirySummary(normalized);
  return normalized;
}

function hasStrongSalesIntent(transcript = '') {
  const text = String(transcript || '').toLowerCase();
  return STRONG_SALES_RE.test(text) && !STRONG_INQUIRY_RE.test(text);
}

function getUserMessages(transcript = '') {
  return String(transcript || '')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.toLowerCase().startsWith('user:'))
    .map((line) => line.replace(/^user:\s*/i, '').trim())
    .filter(Boolean);
}

function normalizeSimpleMessageText(value = '') {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[!?.]+$/g, '')
    .replace(/\s+/g, ' ');
}

function isSimpleVisitorMessage(value = '') {
  const text = normalizeSimpleMessageText(value);
  if (!text) return true;
  if (text.length <= 3) return true;
  return SIMPLE_VISITOR_MESSAGE_RE.test(text);
}

function hasOnlyLowSignalVisitorMessages(transcript = '') {
  const userMessages = getUserMessages(transcript);
  if (!userMessages.length) return true;
  return userMessages.every(isSimpleVisitorMessage);
}

function hasContactDetails(inquiryData = {}, transcript = '') {
  return Boolean(
    cleanValue(inquiryData.email || inquiryData.email_address || inquiryData.contact_email)
    || cleanValue(inquiryData.phone || inquiryData.phone_number || inquiryData.contact_phone)
    || EMAIL_RE.test(String(transcript || ''))
    || PHONE_RE.test(String(transcript || ''))
  );
}

function hasMeaningfulInquiryText(inquiryData = {}) {
  const text = cleanValue(inquiryData.contact_reason || inquiryData.message_summary || inquiryData.summary || inquiryData.message || inquiryData.reason || inquiryData.subject);
  if (!text) return false;
  if (isSimpleVisitorMessage(text)) return false;
  if (LOW_DETAIL_INQUIRY_TEXT_RE.test(normalizeSimpleMessageText(text))) return false;
  return !GENERIC_INQUIRY_SUMMARY_RE.test(text);
}

function hasOwnerActionRequest(inquiryData = {}, transcript = '') {
  const text = `${JSON.stringify(inquiryData || {})}\n${transcript || ''}`;
  return OWNER_ACTION_RE.test(text);
}

function shouldSaveInquiry(inquiryData = {}, transcript = '') {
  const text = String(transcript || '');
  const sourceText = `${JSON.stringify(inquiryData || {})}\n${text}`;
  const normalizedType = normalizeInquiryType(inquiryData.inquiry_type || inquiryData.contact_reason || inquiryData.department_or_route, sourceText);
  const hasExplicitInquiryData = looksLikeInquiryData(inquiryData);
  const hasInquiryIntent = STRONG_INQUIRY_RE.test(text);
  const hasMeaningfulSummary = hasMeaningfulInquiryText(inquiryData);
  const hasContact = hasContactDetails(inquiryData, text);
  const isUrgent = Boolean(inquiryData.urgency_flag) || URGENCY_RE.test(sourceText);
  const hasActionableType = ACTIONABLE_INQUIRY_TYPES.has(normalizedType);
  const hasOwnerAction = hasOwnerActionRequest(inquiryData, text);
  const lowSignalOnly = hasOnlyLowSignalVisitorMessages(text);
  const genericOnly = GENERIC_INQUIRY_SUMMARY_RE.test(sourceText) && !hasMeaningfulSummary;

  // Owner inquiry emails must have both: a useful issue/request summary and a contact method.
  if (!hasContact) return false;
  if (!hasMeaningfulSummary) return false;

  if (hasStrongSalesIntent(text) && !hasOwnerAction && !hasActionableType) return false;
  if (lowSignalOnly) return false;
  if (genericOnly && !isUrgent && !hasActionableType && !hasOwnerAction) return false;

  return Boolean(
    isUrgent
    || (hasOwnerAction && !lowSignalOnly)
    || (hasActionableType && !lowSignalOnly)
    || (hasExplicitInquiryData && (hasActionableType || hasOwnerAction || hasInquiryIntent))
    || (hasInquiryIntent && !lowSignalOnly)
  );
}

export function removeVisibleInquiryJson(text = '') {
  return String(text || '').replace(/INQUIRY_DATA:\s*({[\s\S]*})\s*(?:\n|$)/g, '').trim();
}

export async function saveInquiryFromConversation({ session, conversationHistory = [], userMessage = '', assistantMessage = '', config = {}, namespace = '', notify = true }) {
  try {
    if (!config?.business_id || !session?.id && !session) {
      // `session` can be the DB row or a lightweight object; sessionId is passed separately through the closure in chat.js.
    }

    const transcript = [
      ...conversationHistory.map((m) => `${m.role}: ${m.content}`),
      `user: ${userMessage}`,
      `assistant: ${assistantMessage}`,
    ].join('\n');
    const existing = safeJsonParse(session?.collected_data, {}) || {};
    const fromAssistantJson = extractInquiryDataFromResponse(assistantMessage) || {};
    const rawInquiry = mergeData(existing?.inquiry_data || {}, existing, fromAssistantJson);

    if (!shouldSaveInquiry(rawInquiry, transcript)) return null;

    const inquiryData = normalizeInquiryData(rawInquiry, transcript, config);
    const sessionId = session?.id || session?.session_id || null;
    const dedupeKey = `inquiry:${namespace || config?.bot_id || 'bot'}:${sessionId || inquiryData.email || inquiryData.phone || inquiryData.message_summary || 'anon'}`;
    const wasAlreadyNotified = await redisClient.get(dedupeKey).catch(() => null);

    const result = await pool.query(`
      INSERT INTO inquiries (business_id, session_id, inquiry_type, status, priority, full_name, phone, email, company_name, preferred_contact_method, contact_reason, message_summary, department_or_route, existing_customer, urgency_flag, urgency_reason, ai_summary, raw_data, agents_used, source, created_at, updated_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18::jsonb,$19,'website_chatbot',NOW(),NOW())
      ON CONFLICT (business_id, session_id) WHERE session_id IS NOT NULL
      DO UPDATE SET inquiry_type=EXCLUDED.inquiry_type, status=CASE WHEN inquiries.status='resolved' THEN inquiries.status ELSE EXCLUDED.status END, priority=EXCLUDED.priority, full_name=COALESCE(EXCLUDED.full_name,inquiries.full_name), phone=COALESCE(EXCLUDED.phone,inquiries.phone), email=COALESCE(EXCLUDED.email,inquiries.email), company_name=COALESCE(EXCLUDED.company_name,inquiries.company_name), preferred_contact_method=COALESCE(EXCLUDED.preferred_contact_method,inquiries.preferred_contact_method), contact_reason=COALESCE(EXCLUDED.contact_reason,inquiries.contact_reason), message_summary=COALESCE(EXCLUDED.message_summary,inquiries.message_summary), department_or_route=COALESCE(EXCLUDED.department_or_route,inquiries.department_or_route), existing_customer=EXCLUDED.existing_customer, urgency_flag=EXCLUDED.urgency_flag, urgency_reason=COALESCE(EXCLUDED.urgency_reason,inquiries.urgency_reason), ai_summary=EXCLUDED.ai_summary, raw_data=inquiries.raw_data || EXCLUDED.raw_data, agents_used=EXCLUDED.agents_used, updated_at=NOW()
      RETURNING *`, [
      config.business_id,
      sessionId,
      inquiryData.inquiry_type,
      inquiryData.status,
      inquiryData.priority,
      inquiryData.full_name,
      inquiryData.phone,
      inquiryData.email,
      inquiryData.company_name,
      inquiryData.preferred_contact_method,
      inquiryData.contact_reason,
      inquiryData.message_summary,
      inquiryData.department_or_route,
      inquiryData.existing_customer,
      inquiryData.urgency_flag,
      inquiryData.urgency_reason,
      inquiryData.ai_summary,
      JSON.stringify(inquiryData.raw_data || inquiryData),
      inquiryData.agents_used || [],
    ]);

    const savedInquiry = result?.rows?.[0] || null;
    if (notify && savedInquiry?.id && !wasAlreadyNotified && hasContactDetails(inquiryData, transcript)) {
      await redisClient.setex(dedupeKey, 3600, '1').catch((e) => console.error(e.message));
      sendInquiryAlert(config, savedInquiry).catch((err) => console.error('Inquiry email alert failed:', err.message));
    }

    return savedInquiry;
  } catch (error) {
    console.error('saveInquiryFromConversation error:', error.message);
    return null;
  }
}
