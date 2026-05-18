const EMAIL_REGEX = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/;
const PHONE_REGEX = /(\+?\d{1,3}[-.\s]?)?\(?\d{2,4}\)?[-.\s]?\d{3,4}[-.\s]?\d{3,4}/;
const NAME_REGEX = /\b([A-Z][a-z]+)\s+([A-Z][a-z]+)\b/i;
const INTENT_KEYWORDS = ['buy', 'purchase', 'pricing', 'price', 'cost', 'demo', 'book a demo', 'contact', 'call me', 'email me', 'trial', 'sign up', 'subscribe', 'get started', 'sales', 'offer', 'discount', 'plan'];

export function detectLead(message) {
  let score = 0;
  const contactInfo = { name: null, email: null, phone: null };
  const reasons = [];

  const emailMatch = message.match(EMAIL_REGEX);
  if (emailMatch) { contactInfo.email = emailMatch[0]; score += 30; reasons.push('Email'); }
  const phoneMatch = message.match(PHONE_REGEX);
  if (phoneMatch) { contactInfo.phone = phoneMatch[0]; score += 25; reasons.push('Phone'); }
  const nameMatch = message.match(NAME_REGEX);
  if (nameMatch) { contactInfo.name = `${nameMatch[1]} ${nameMatch[2]}`; score += 20; reasons.push('Name'); }
  const lowerMsg = message.toLowerCase();
  const foundKeywords = INTENT_KEYWORDS.filter(kw => lowerMsg.includes(kw));
  if (foundKeywords.length) { score += 15; reasons.push(`Intent: ${foundKeywords.join(',')}`); }
  if (message.length > 50) { score += 5; reasons.push('Long message'); }
  if (message.includes('?')) { score += 5; reasons.push('Question'); }

  score = Math.min(score, 100);
  const isLead = (score >= 30) || !!(contactInfo.email || contactInfo.phone);
  return { isLead, score, contactInfo, reason: reasons.join(', ') || 'Low intent' };
}

const SERVICE_NEED_PATTERNS = [
  { key: 'new website', regex: /\b(new website|need a new website|website rebuild)\b/i },
  { key: 'website redesign', regex: /\b(redesign|website redesign|refresh our website)\b/i },
  { key: 'hosting', regex: /\b(hosting|host our site|website hosting)\b/i },
  { key: 'support', regex: /\b(support|maintenance|help manage)\b/i },
  { key: 'management', regex: /\b(management|managed website|manage our website)\b/i },
  { key: 'online giving', regex: /\b(online giving|donation|tithe|donate online)\b/i },
  { key: 'sermons', regex: /\b(sermons|sermon uploads|podcast sermons)\b/i },
  { key: 'events', regex: /\b(events|event calendar)\b/i },
  { key: 'booking', regex: /\b(booking|bookings|book a call|schedule a call|appointment)\b/i },
  { key: 'call', regex: /\b(call me|phone call|talk by phone)\b/i }
];

export function extractDeterministicLeadData(message = '') {
  const text = String(message || '').trim();
  if (!text) return null;

  const email = (text.match(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/) || [null])[0];
  const phone = (text.match(/(?:\+?\d[\d\s().-]{7,}\d)/) || [null])[0];
  const nameMatch = text.match(/\b(?:my name is|i am|i'm)\s+([A-Za-z][A-Za-z\s'.-]{1,60}?)(?=,|\.|\band\b|\bfrom\b|$)/i);
  const fromOrgMatch = text.match(/\bfrom\s+([A-Za-z0-9&'\-.\s]{2,80}?)(?=,|\.|\bmy\s+email\s+is\b|\bwe\b|$)/i);
  const ourOrgMatch = text.match(/\bour\s+(?:church|company|organisation|organization|ministry)\s+is\s+([A-Za-z0-9&'\-.\s]{2,80}?)(?=,|\.|$)/i);
  const inLocationMatch = text.match(/\bin\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,2})(?=,|\.|$)/);

  let serviceNeed = null;
  const needPhrase = text.match(/\b(?:need|looking for|want)\s+(.*?)(?:\.|$)/i);
  if (needPhrase?.[1]) serviceNeed = needPhrase[1].trim();
  if (!serviceNeed) {
    const matched = SERVICE_NEED_PATTERNS.filter((item) => item.regex.test(text)).map((item) => item.key);
    if (matched.length) serviceNeed = matched.join(', ');
  }

  const churchName = fromOrgMatch?.[1]?.trim() || ourOrgMatch?.[1]?.trim() || null;
  const location = inLocationMatch?.[1] || (() => {
    if (!churchName) return null;
    const city = churchName.match(/\b([A-Z][a-z]+)\s*$/);
    return city?.[1] || null;
  })();

  const normalized = {
    name: nameMatch?.[1]?.trim() || null,
    email: email || null,
    phone: phone || null,
    churchName,
    company_name: churchName,
    location: location || null,
    serviceNeed: serviceNeed || null,
    score_reasons: ['deterministic_extraction'],
    lead_score: /(urgent|asap|immediately)/i.test(text) ? 'hot' : 'warm'
  };

  const hasLeadSignal = Boolean(
    normalized.email ||
    normalized.phone ||
    (normalized.name && normalized.churchName && normalized.serviceNeed)
  );
  return hasLeadSignal ? normalized : null;
}
