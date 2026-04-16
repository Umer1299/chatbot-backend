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