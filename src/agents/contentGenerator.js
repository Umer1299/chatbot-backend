import { scrapeLLM } from '../services/aiService.js';

const FALLBACK_WELCOME = 'Hi! Thanks for reaching out. How can we help you today?';
const FALLBACK_PROMPTS = [
  'What services do you offer?',
  'How can I book an appointment?',
  'What are your business hours?',
];

const PROMPT_KEYS = ['prompt', 'text', 'question', 'label', 'title', 'content', 'value', 'message'];

function contextualFallbackPrompts(businessInfo = {}) {
  const services = Array.isArray(businessInfo.primaryServices)
    ? businessInfo.primaryServices.filter(Boolean).map((value) => String(value).trim())
    : [];
  const industry = String(businessInfo.industry || '').toLowerCase();

  const servicePrompt = services[0]
    ? `Can you tell me more about your ${services[0]} services?`
    : 'What services do you offer?';

  if (industry === 'web_agency' || /website|web design|branding|hosting|digital/.test(services.join(' ').toLowerCase())) {
    return [
      servicePrompt,
      'Do you build church websites or ministry-focused websites?',
      'What are your website design package options and timelines?',
    ];
  }

  return [servicePrompt, ...FALLBACK_PROMPTS.slice(1)];
}

function normalizePromptItem(item) {
  if (typeof item === 'string') return [item.trim()];
  if (Array.isArray(item)) return item.flatMap((entry) => normalizePromptItem(entry));
  if (!item || typeof item !== 'object') return [];

  for (const key of PROMPT_KEYS) {
    const value = item[key];
    if (typeof value === 'string') return [value.trim()];
    if (Array.isArray(value)) return value.flatMap((entry) => normalizePromptItem(entry));
    if (value && typeof value === 'object') return normalizePromptItem(value);
  }

  return [];
}

export function parseStarterPromptsResponse(parsed, businessInfo = {}) {
  if (!Array.isArray(parsed)) return contextualFallbackPrompts(businessInfo);

  const prompts = parsed
    .flatMap((item) => normalizePromptItem(item))
    .map((prompt) => String(prompt || '').trim())
    .filter((prompt) => prompt && prompt !== '[object Object]');

  const unique = [...new Set(prompts)];
  const fallback = contextualFallbackPrompts(businessInfo);
  while (unique.length < 3) {
    const next = fallback.find((item) => !unique.includes(item));
    if (!next) break;
    unique.push(next);
  }

  return unique.slice(0, 3);
}

function buildBusinessSummary(businessInfo = {}, validation = {}) {
  return {
    industry: businessInfo.industry || 'unknown',
    businessName: businessInfo.businessName || 'this business',
    primaryServices: Array.isArray(businessInfo.primaryServices) ? businessInfo.primaryServices : [],
    location: businessInfo.location || '',
    ownerPhone: businessInfo.ownerPhone || '',
    calendlyLink: businessInfo.calendlyLink || '',
    qualityScore: Number.isFinite(validation?.score) ? validation.score : null,
    missingCritical: validation?.missing?.critical || [],
    missingImportant: validation?.missing?.important || [],
  };
}

export async function generateWelcomeMessage(businessInfo = {}, validation = {}) {
  try {
    const summary = buildBusinessSummary(businessInfo, validation);
    const systemPrompt = 'You write concise website chatbot welcome messages. Return plain text only.';
    const messages = [
      {
        role: 'user',
        content: `Write one warm welcome message in <= 160 characters for this business profile:\n${JSON.stringify(summary)}`,
      },
    ];

    const response = await scrapeLLM(systemPrompt, messages, { maxTokens: 120 });
    const text = String(response || '').trim().replace(/^"|"$/g, '');
    return text || FALLBACK_WELCOME;
  } catch (error) {
    console.error('WELCOME_MESSAGE_GENERATION_ERROR:', error);
    return FALLBACK_WELCOME;
  }
}

export async function generateStarterPrompts(businessInfo = {}, validation = {}) {
  try {
    const summary = buildBusinessSummary(businessInfo, validation);
    const systemPrompt = 'You create short first-click chatbot prompts. Return JSON array only.';
    const messages = [
      {
        role: 'user',
        content: `Create exactly 3 short user prompts for this business.\nProfile:\n${JSON.stringify(summary)}`,
      },
    ];

    const response = await scrapeLLM(systemPrompt, messages, { maxTokens: 200 });
    const cleaned = String(response || '').replace(/```json/gi, '').replace(/```/g, '').trim();
    const parsed = JSON.parse(cleaned);

    return parseStarterPromptsResponse(parsed, businessInfo);
  } catch (error) {
    console.error('STARTER_PROMPTS_GENERATION_ERROR:', error);
    return contextualFallbackPrompts(businessInfo);
  }
}

export async function generateChatbotContent(
  businessInfo = {},
  selectedAgentIds = [],
  availabilitySlots = null,
  validation = {},
) {
  const welcomeMessage = await generateWelcomeMessage(businessInfo, validation);
  const starterPrompts = await generateStarterPrompts(businessInfo, validation);

  const services = Array.isArray(businessInfo.primaryServices)
    ? businessInfo.primaryServices.filter(Boolean).join(', ')
    : '';

  const systemPrompt = [
    `You are the assistant for ${businessInfo.businessName || 'this business'}.`,
    businessInfo.industry ? `Industry: ${businessInfo.industry}.` : '',
    businessInfo.location ? `Location: ${businessInfo.location}.` : '',
    services ? `Services: ${services}.` : '',
    businessInfo.ownerPhone ? `Phone: ${businessInfo.ownerPhone}.` : '',
    businessInfo.calendlyLink ? `Booking link: ${businessInfo.calendlyLink}.` : '',
    Array.isArray(selectedAgentIds) && selectedAgentIds.length
      ? `Enabled specialist agents: ${selectedAgentIds.join(', ')}.`
      : '',
    availabilitySlots ? 'Availability slots configured: yes.' : 'Availability slots configured: no.',
    'Be accurate, concise, and ask clarifying questions when needed.',
  ]
    .filter(Boolean)
    .join(' ');

  return {
    welcomeMessage,
    starterPrompts,
    systemPrompt,
  };
}

export default {
  generateChatbotContent,
  generateWelcomeMessage,
  generateStarterPrompts,
};
