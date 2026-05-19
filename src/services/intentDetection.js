function normalizeText(input = '') {
  return String(input)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const STRICT_SIMPLE_MESSAGES = new Set(['hi', 'hello', 'hey', 'thanks', 'thank you', 'ok', 'okay', 'bye', 'goodbye']);

const SIMPLE_INTENT_BY_TEXT = {
  hi: 'greeting',
  hello: 'greeting',
  hey: 'greeting',
  thanks: 'thanks',
  'thank you': 'thanks',
  ok: 'acknowledgement',
  okay: 'acknowledgement',
  bye: 'bye',
  goodbye: 'bye'
};

const GLOBAL_PROJECT_KEYWORDS = [
  'need','want','looking for','can you help','what next','quote','price','pricing','cost','budget','timeline','launch','appointment','consultation','call','demo','support','manage','management','update','repair','build','redesign','hosting','order','refund','return','delivery','booking','service','services'
];

const INDUSTRY_KEYWORDS = {
  web_agency: ['website','redesign','hosting','seo','domain','cms','events','sermon','sermons','donation','donations','monthly updates','youtube'],
  construction: ['renovation','extension','roofing','quote','estimate','repair','site visit','materials','project','roof'],
  real_estate: ['property','viewing','rent','buy','sell','valuation','bedrooms','mortgage'],
  healthcare: ['appointment','doctor','dentist','clinic','symptoms','treatment','consultation','urgent'],
  law_firm: ['legal','solicitor','lawyer','case','contract','divorce','immigration','claim','consultation'],
  ecommerce: ['order','tracking','delivery','refund','return','product','stock','payment'],
  saas: ['demo','pricing','integration','api','onboarding','trial','subscription'],
  'saas/software': ['demo','pricing','integration','api','onboarding','trial','subscription']
};

const SUPPORT_KEYWORDS = ['support','issue','problem','not working','help','refund','return','delivery','tracking','where is my order'];
const FAQ_KEYWORDS = ['hours','open','location','address','price','pricing','cost','services','do you offer'];
const BOOKING_KEYWORDS = ['book','booking','schedule','appointment','consultation','call','demo','site visit'];

function includesKeyword(text, keyword) {
  if (!keyword) return false;
  if (keyword.includes(' ')) return text.includes(keyword);
  return new RegExp(`\\b${keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(text);
}

function getIndustryKeywordList(industry, botConfig = {}) {
  const normalized = normalizeText(industry || botConfig.industry || '');
  const matchedKey = Object.keys(INDUSTRY_KEYWORDS).find((k) => normalizeText(k) === normalized) || normalized;
  const base = INDUSTRY_KEYWORDS[matchedKey] || [];
  const custom = [
    ...(Array.isArray(botConfig.intent_keywords) ? botConfig.intent_keywords : []),
    ...(Array.isArray(botConfig.project_keywords) ? botConfig.project_keywords : []),
    ...(Array.isArray(botConfig.detected_services) ? botConfig.detected_services : [])
  ].map((k) => normalizeText(k)).filter(Boolean);
  return Array.from(new Set([...base, ...custom]));
}

export function detectMessageIntent(message, industry, botConfig = {}) {
  const normalized = normalizeText(message);
  const reasons = [];
  const addReason = (reason) => { if (reason && !reasons.includes(reason)) reasons.push(reason); };

  const simpleIntent = SIMPLE_INTENT_BY_TEXT[normalized] || null;
  const hasLeadPattern = /\b(my name is|i am|i'm|we are|email|phone|call me|company|organisation|organization|church)\b/i.test(message)
    || /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i.test(message)
    || /\+?\d[\d\s().-]{7,}/.test(message);

  const industryKeywords = getIndustryKeywordList(industry, botConfig);
  const globalProjectTerms = GLOBAL_PROJECT_KEYWORDS.filter((k) => includesKeyword(normalized, k));
  const industryTerms = industryKeywords.filter((k) => includesKeyword(normalized, k));
  const supportTerms = SUPPORT_KEYWORDS.filter((k) => includesKeyword(normalized, k));
  const faqTerms = FAQ_KEYWORDS.filter((k) => includesKeyword(normalized, k));
  const bookingTerms = BOOKING_KEYWORDS.filter((k) => includesKeyword(normalized, k));

  globalProjectTerms.forEach(addReason);
  industryTerms.forEach(addReason);
  if (includesKeyword(normalized, 'volunteers')) addReason('volunteers');

  const bookingIntent = bookingTerms.length > 0 || /\b(book a call|schedule a call|arrange a call|book (a )?(demo|appointment|consultation))\b/i.test(normalized);
  const leadIntent = hasLeadPattern;
  const projectIntent = globalProjectTerms.length > 0 || industryTerms.length > 0;
  const supportIntent = supportTerms.length > 0;
  const faqIntent = faqTerms.length > 0;

  const longBusinessMessage = normalized.length > 20 && (projectIntent || bookingIntent || supportIntent || leadIntent);
  const shouldUseSimpleReply = Boolean(simpleIntent)
    && STRICT_SIMPLE_MESSAGES.has(normalized)
    && !longBusinessMessage
    && !bookingIntent
    && !leadIntent
    && !projectIntent
    && !supportIntent;

  return { simpleIntent, bookingIntent, leadIntent, projectIntent, supportIntent, faqIntent, shouldUseSimpleReply, reasons };
}

export function buildSimpleReply(intent, config = {}) {
  const businessName = config.business_name ? ` at ${config.business_name}` : '';
  const services = Array.isArray(config.detected_services) && config.detected_services.length > 0
    ? ` We offer ${config.detected_services.slice(0, 3).join(', ')}.`
    : '';
  if (intent === 'greeting') return `${config.welcome_message || `Hi! Welcome${businessName}.`}${services}`.trim();
  if (intent === 'thanks') return `You’re very welcome${businessName}! Happy to help anytime.`;
  if (intent === 'acknowledgement') return `Great — sounds good. I’m here whenever you’re ready for the next step.`;
  if (intent === 'bye') return `Thanks for chatting${businessName}. Have a blessed day!`;
  return null;
}
