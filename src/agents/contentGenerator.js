import { claudeChat } from '../services/aiService.js';

const FALLBACK_WELCOME = 'Hi! Thanks for reaching out. How can we help you today?';
const FALLBACK_PROMPTS = [
  'What services do you offer?',
  'How can I book an appointment?',
  'What are your business hours?',
];
const CONTENT_GENERATION_TIMEOUT_MS = Number(process.env.CONTENT_GENERATION_TIMEOUT_MS || 15000);

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

function withTimeout(promise, timeoutMs, label) {
  let timeoutId;
  const timeoutPromise = new Promise((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
  });

  return Promise.race([promise, timeoutPromise]).finally(() => clearTimeout(timeoutId));
}

function buildFallbackWelcomeMessage(businessInfo = {}) {
  const name = businessInfo.businessName || 'there';
  if (name && name !== 'this business') {
    return `Hi! Welcome to ${name}. How can we help you today?`;
  }
  return FALLBACK_WELCOME;
}

function promptToText(item) {
  if (typeof item === 'string') return item;
  if (!item || typeof item !== 'object') return '';

  return item.prompt
    || item.text
    || item.label
    || item.title
    || item.question
    || item.message
    || item.value
    || item.name
    || '';
}

function normalizePromptArray(value) {
  const prompts = Array.isArray(value)
    ? value
    : typeof value === 'string'
      ? value.split('\n')
      : [];

  return prompts
    .map(promptToText)
    .map((item) => String(item || '').trim())
    .map((item) => item.replace(/^[-*\d.)\s]+/, '').trim())
    .filter(Boolean)
    .slice(0, 3);
}

function buildFallbackStarterPrompts(businessInfo = {}) {
  const services = Array.isArray(businessInfo.primaryServices)
    ? businessInfo.primaryServices.filter(Boolean).slice(0, 2)
    : [];

  const prompts = [
    services.length ? `Tell me about ${services[0]}` : 'What services do you offer?',
    'How much does it cost?',
    businessInfo.calendlyLink ? 'How can I book a call?' : 'How can I contact you?',
  ];

  return prompts.slice(0, 3);
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

    const response = await withTimeout(
      claudeChat(systemPrompt, messages, { maxTokens: 120 }),
      CONTENT_GENERATION_TIMEOUT_MS,
      'Welcome message generation',
    );
    const text = String(response || '').trim().replace(/^"|"$/g, '');
    return text || buildFallbackWelcomeMessage(businessInfo);
  } catch (error) {
    console.error('WELCOME_MESSAGE_GENERATION_ERROR:', error.message || error);
    return buildFallbackWelcomeMessage(businessInfo);
  }
}

export async function generateStarterPrompts(businessInfo = {}, validation = {}) {
  try {
    const summary = buildBusinessSummary(businessInfo, validation);
    const systemPrompt = 'You create short first-click chatbot prompts. Return JSON array of strings only, like ["What services do you offer?", "How much does it cost?", "How can I contact you?"]. Do not return objects.';
    const messages = [
      {
        role: 'user',
        content: `Create exactly 3 short user prompts for this business. Return only a JSON array of strings.\nProfile:\n${JSON.stringify(summary)}`,
      },
    ];

    const response = await withTimeout(
      claudeChat(systemPrompt, messages, { maxTokens: 200 }),
      CONTENT_GENERATION_TIMEOUT_MS,
      'Starter prompts generation',
    );
    const cleaned = String(response || '').replace(/```json/gi, '').replace(/```/g, '').trim();
    const parsed = JSON.parse(cleaned);

    const prompts = normalizePromptArray(parsed);
    return prompts.length ? prompts : buildFallbackStarterPrompts(businessInfo);
  } catch (error) {
    console.error('STARTER_PROMPTS_GENERATION_ERROR:', error.message || error);
    return buildFallbackStarterPrompts(businessInfo);
  }
}

export async function generateChatbotContent(
  businessInfo = {},
  selectedAgentIds = [],
  availabilitySlots = null,
  validation = {},
) {
  const [welcomeMessage, rawStarterPrompts] = await Promise.all([
    generateWelcomeMessage(businessInfo, validation),
    generateStarterPrompts(businessInfo, validation),
  ]);
  const starterPrompts = normalizePromptArray(rawStarterPrompts).length
    ? normalizePromptArray(rawStarterPrompts)
    : buildFallbackStarterPrompts(businessInfo);

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
    availabilitySlots ? `Availability slots configured: yes.` : 'Availability slots configured: no.',
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
