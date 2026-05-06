import { claudeChat } from '../services/aiService.js';

const FALLBACK_WELCOME = 'Hi! Thanks for reaching out. How can we help you today?';
const FALLBACK_PROMPTS = [
  'What services do you offer?',
  'How can I book an appointment?',
  'What are your business hours?',
];

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

    const response = await claudeChat(systemPrompt, messages, { maxTokens: 120 });
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

    const response = await claudeChat(systemPrompt, messages, { maxTokens: 200 });
    const cleaned = String(response || '').replace(/```json/gi, '').replace(/```/g, '').trim();
    const parsed = JSON.parse(cleaned);

    if (!Array.isArray(parsed)) return FALLBACK_PROMPTS;

    const prompts = parsed
      .map((item) => String(item || '').trim())
      .filter(Boolean)
      .slice(0, 3);

    return prompts.length ? prompts : FALLBACK_PROMPTS;
  } catch (error) {
    console.error('STARTER_PROMPTS_GENERATION_ERROR:', error);
    return FALLBACK_PROMPTS;
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
