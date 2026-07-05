import { AGENT_TEMPLATES } from './templates.js';

const UNIVERSAL_CONTACT_ROUTER_AGENT = Object.freeze({
  id: 'general_contact_router',
  name: 'General Contact Router',
  description: 'Handles useful owner inquiries such as complaints, support requests, existing-customer issues, human handoff, partnerships, careers, and unclear enquiries before routing to the right person.',
  phase: 1,
  recommended: true,
  locked: false,
  collectsFields: [
    'inquiry_type',
    'contact_reason',
    'message_summary',
    'contact_name',
    'contact_email',
    'contact_phone',
    'preferred_contact_method',
    'urgency_level',
    'existing_customer',
    'department_or_route',
  ],
  quickReplies: [
    'Get a Quote',
    'Ask a Question',
    'Book a Call',
    'Support / Existing Customer',
    'Complaint',
    'Partnership / Careers',
    'Other',
  ],
  triggerKeywords: [
    'contact',
    'support',
    'help',
    'complaint',
    'issue',
    'problem',
    'not happy',
    'call me',
    'speak to someone',
    'speak to a person',
    'human',
    'real person',
    'job',
    'career',
    'partnership',
    'supplier',
    'general enquiry',
    'general inquiry',
  ],
  scoringRules: {
    high: 'complaint, urgent support, human handoff, or time-sensitive issue with useful details and contact method',
    normal: 'support, existing customer, partnership, supplier, career, or owner-action inquiry with useful details and contact method',
    low: 'vague browsing inquiry with no owner action required',
  },
  promptInstructions: `Use this as an inquiry agent only when the visitor has a real owner-action request: complaint, support issue, existing-customer concern, billing/admin issue, human handoff, partnership, supplier, career, or asks the owner/team to contact them.
Do not treat greetings, simple questions, browsing, FAQs, or general service questions as inquiries. Answer those normally or ask a normal helpful follow-up.
Do not interrupt or replace a more specific active industry flow when the visitor clearly wants a quote, appointment, property viewing, demo, pricing help, technical setup, or emergency help.
When the visitor has an inquiry but details are missing, respond like a human support person: acknowledge briefly, then ask what happened or what they need help with. Ask only one clear question at a time.
After the issue or concern is clear, ask for a useful contact method: phone or email. If helpful, also ask for name and company/order/reference, but keep it natural.
Do not say the owner/team will be notified until at least one contact method is captured.
Do not output INQUIRY_DATA until both are true: (1) issue/concern/request summary is useful, and (2) phone or email has been provided.
For support or existing-customer messages, collect short issue summary, whether they are an existing customer, name if available, and at least one contact method.
For complaints, acknowledge calmly, collect what happened, urgency, name if available, and one contact method.
For requests to speak to a human, first ask what they need help with if unclear, then collect one contact method before handoff.
For partnership, supplier, or career messages, collect purpose, company/organisation if relevant, and email or phone before saving.
Use LEAD_DATA only when the visitor clearly asks for a quote, demo, appointment, consultation, pricing, or a new project/service.
Never output both INQUIRY_DATA and LEAD_DATA in the same reply.
When an inquiry is complete and should be saved, output INQUIRY_DATA on its own line with valid JSON only using this shape: {"inquiry_type":"general|support|complaint|human_handoff|partnership|career|supplier|billing|technical_support|other","contact_reason":"string or null","message_summary":"string or null","contact_name":"string or null","contact_email":"string or null","contact_phone":"string or null","company_name":"string or null","preferred_contact_method":"email|phone|callback|null","existing_customer":false,"department_or_route":"support|admin|careers|partnerships|billing|owner|null","priority":"low|normal|high","urgency_flag":false,"urgency_reason":"string or null","agents_used":["general_contact_router"]}.
Signal PHASE_1_COMPLETE only when a useful issue/request summary and at least one contact method are available.`,
});

const TARGET_INDUSTRIES = [
  'construction',
  'web_agency',
  'real_estate',
  'healthcare',
  'law_firm',
  'saas_software',
];

function cloneUniversalContactRouterAgent() {
  return {
    ...UNIVERSAL_CONTACT_ROUTER_AGENT,
    collectsFields: [...UNIVERSAL_CONTACT_ROUTER_AGENT.collectsFields],
    quickReplies: [...UNIVERSAL_CONTACT_ROUTER_AGENT.quickReplies],
    triggerKeywords: [...UNIVERSAL_CONTACT_ROUTER_AGENT.triggerKeywords],
    scoringRules: { ...UNIVERSAL_CONTACT_ROUTER_AGENT.scoringRules },
  };
}

for (const industryKey of TARGET_INDUSTRIES) {
  const industryTemplate = AGENT_TEMPLATES[industryKey];
  if (!industryTemplate?.agents) continue;
  if (industryTemplate.agents.general_contact_router) continue;

  industryTemplate.agents.general_contact_router = cloneUniversalContactRouterAgent();
}

export { UNIVERSAL_CONTACT_ROUTER_AGENT };
