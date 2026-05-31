const SERVICE_KEYWORDS = /\b(service|offer|provide|we do|cabinet|floor|paint|install|repair|renovate)\b/;
const PRICING_KEYWORDS = /\b(price|cost|how much|budget|quote|fee|discount)\b/;
const BOOKING_KEYWORDS = /\b(book|schedule|appointment|calendar|reserve|availability)\b/;
const LOCATION_KEYWORDS = /\b(where|location|address|area|city|near|serve)\b/;
const SUPPORT_KEYWORDS = /\b(help|support|problem|issue|not working|how to)\b/;
const COMPLAINT_KEYWORDS = /\b(angry|bad|terrible|refund|complain|unhappy|want to speak)\b/;

const UNANSWERED_REPLY_PATTERNS = [
  /\bi don't know\b/,
  /\bi'm not sure\b/,
  /\bi don't have that information\b/,
  /\bplease contact\b/,
  /\bthere (?:might be |may be )?some confusion\b/,
  /\bwe (?:speciali[sz]e|focus) (?:in|on)\b[\s\S]{0,120}\bnot\b/,
  /\bnot (?:a|an|the)?\s*(?:physical )?(?:item|product|service)s?\b/,
  /\b(?:outside|out of) (?:our|the) scope\b/,
  /\bnot something we (?:offer|provide|do|can help with)\b/,
  /\bcan't help (?:with|you with) that\b/,
];

export function detectIntentCategory(text = '') {
  const lower = String(text || '').toLowerCase();
  if (PRICING_KEYWORDS.test(lower)) return 'pricing';
  if (BOOKING_KEYWORDS.test(lower)) return 'booking';
  if (SERVICE_KEYWORDS.test(lower)) return 'services';
  if (LOCATION_KEYWORDS.test(lower)) return 'location';
  if (SUPPORT_KEYWORDS.test(lower)) return 'support';
  if (COMPLAINT_KEYWORDS.test(lower)) return 'complaint';
  return 'generic';
}

export function checkIfUnanswered(aiReply = '', contextUsed = '') {
  const replyText = String(aiReply || '');
  const lower = replyText.toLowerCase();
  const short = replyText.length < 20;
  const noContext = !contextUsed || contextUsed.length === 0;

  if (UNANSWERED_REPLY_PATTERNS.some((pattern) => pattern.test(lower))) {
    return true;
  }
  if (short && noContext) return true;
  return false;
}
