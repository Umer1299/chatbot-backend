import { AGENT_TEMPLATES } from './templates.js';

const UNIVERSAL_CONTACT_ROUTER_AGENT = Object.freeze({
  id: 'general_contact_router',
  name: 'General Contact Router',
  description: 'Handles general contact-form replacement messages, support requests, complaints, human handoff, partnerships, careers, and unclear enquiries before routing to the right industry agent.',
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
    high: 'complaint, urgent support, human handoff, or time-sensitive issue',
    normal: 'general question, support, existing customer, partnership, supplier, or career inquiry',
    low: 'vague browsing inquiry with no contact urgency',
  },
  promptInstructions: `Use this as a contact-form replacement router when the visitor's intent is unclear, general, support-related, complaint-related, or human-handoff related.
Do not interrupt or replace a more specific active industry flow when the visitor clearly wants a quote, appointment, property viewing, demo, pricing help, technical setup, or emergency help.
If intent is unclear, ask one short routing question using quick replies.
For support or existing-customer messages, collect a short issue summary, whether they are an existing customer, name, and at least one contact method when possible.
For complaints, acknowledge calmly, collect what happened, urgency, name, and one contact method when possible, then mark urgency_flag true when the issue is time-sensitive or reputationally sensitive.
For requests to speak to a human, collect name and at least one contact method before handoff when possible.
For partnership, supplier, or career messages, collect purpose, company/organisation if relevant, email if possible, and route as non-sales unless the message shows clear commercial intent.
For healthcare and law firm categories, never give medical or legal advice. Route urgent medical/legal safety issues to the existing urgent agents where present.
Ask one clear question at a time and do not sound like a form.
Use INQUIRY_DATA for general contact, support, complaints, human handoff, partnerships, careers, suppliers, billing/admin questions, existing customer issues, and unclear non-sales messages.
Use LEAD_DATA only when the visitor clearly asks for a quote, demo, appointment, consultation, pricing, or a new project/service.
Never output both INQUIRY_DATA and LEAD_DATA in the same reply.
When an inquiry should be saved, output INQUIRY_DATA on its own line with valid JSON only using this shape: {"inquiry_type":"general|support|complaint|human_handoff|partnership|career|supplier|billing|technical_support|other","contact_reason":"string or null","message_summary":"string or null","contact_name":"string or null","contact_email":"string or null","contact_phone":"string or null","company_name":"string or null","preferred_contact_method":"email|phone|callback|null","existing_customer":false,"department_or_route":"support|admin|careers|partnerships|billing|owner|null","priority":"low|normal|high","urgency_flag":false,"urgency_reason":"string or null","agents_used":["general_contact_router"]}.
Signal PHASE_1_COMPLETE when contact_reason and message_summary are clear, even if contact details are not yet available.`,
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
