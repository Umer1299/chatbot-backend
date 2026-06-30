import { AGENT_TEMPLATES } from './templates.js';

const UNIVERSAL_CONTACT_ROUTER_AGENT = Object.freeze({
  id: 'general_contact_router',
  name: 'General Contact Router',
  description: 'Handles general contact-form replacement messages, support requests, complaints, human handoff, partnerships, careers, and unclear enquiries before routing to the right industry agent.',
  phase: 1,
  recommended: true,
  locked: false,
  collectsFields: [
    'contact_reason',
    'message_summary',
    'contact_name',
    'contact_email',
    'contact_phone',
    'preferred_contact_method',
    'urgency_level',
    'existing_customer',
    'department_or_route',
    'lead_score',
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
    hot: 'sales intent OR urgent issue AND contact method captured',
    warm: 'clear question/support request with contact method but no immediate sales intent',
    cold: 'career, supplier, partnership, vague question, or browsing without contact urgency',
  },
  promptInstructions: `Use this as a contact-form replacement router when the visitor's intent is unclear, general, support-related, complaint-related, or human-handoff related.
Do not interrupt or replace a more specific active industry flow when the visitor clearly wants a quote, appointment, property viewing, legal consultation, demo, pricing help, technical setup, or emergency help.
If intent is unclear, ask one short routing question using quick replies.
For sales or booking intent, route back into the relevant industry agent after capturing the reason in natural language.
For support or existing-customer messages, collect a short issue summary, whether they are an existing customer, name, and at least one contact method.
For complaints, acknowledge calmly, do not argue, collect what happened, urgency, name, and one contact method, then mark urgency_flag true when the issue is time-sensitive or reputationally sensitive.
For requests to speak to a human, collect name and at least one contact method before handoff.
For partnership, supplier, or career messages, collect purpose, company/organisation if relevant, email, and route as non-sales unless the message shows clear commercial intent.
For healthcare and law firm categories, never give medical or legal advice. Route urgent medical/legal safety issues to the existing urgent agents where present.
Ask one clear question at a time and do not sound like a form.
Signal PHASE_1_COMPLETE when contact_reason, message_summary, and at least one contact method are collected, or when the visitor is clearly routed to a more specific selected agent.`,
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
