import { AGENT_TEMPLATES } from './templates.js';

const SAAS_SOFTWARE_TEMPLATE = {
  industryName: 'SaaS / Software',
  emoji: '🤖',
  agents: {
    product_discovery: {
      id: 'product_discovery',
      name: 'Product Discovery',
      description: 'Understands visitor needs, use case, current website setup, and the main goal for using an AI agent.',
      phase: 1,
      recommended: true,
      locked: false,
      collectsFields: [
        'business_type',
        'website_url',
        'main_goal',
        'current_challenge',
        'timeline',
      ],
      quickReplies: [
        'Lead Capture',
        'Customer Support',
        'Book Calls',
        'Answer FAQs',
        'Qualify Leads',
        'Other',
      ],
      triggerKeywords: [],
      scoringRules: null,
      promptInstructions: `Start by asking what they want the AI agent to help with using quick replies.
Then ask what type of business they run.
Ask for their website URL so the team can review where Chatflow AI would be installed.
Focus on the business outcome, not technical features.
Never ask about budget in Phase 1.
Signal PHASE_1_COMPLETE when business type, website, goal, challenge, and timeline are collected.`,
    },

    lead_qualification: {
      id: 'lead_qualification',
      name: 'Lead Qualification',
      description: 'Qualifies SaaS leads by business size, decision-maker status, budget, urgency, and pilot readiness.',
      phase: 2,
      recommended: true,
      locked: false,
      collectsFields: [
        'contact_name',
        'contact_email',
        'contact_phone',
        'company_name',
        'monthly_website_leads',
        'budget_range',
        'is_decision_maker',
        'lead_score',
      ],
      quickReplies: [],
      triggerKeywords: [],
      scoringRules: {
        hot: 'decision maker confirmed AND website is live AND wants setup within 30 days',
        warm: 'clear use case but timeline or budget is flexible',
        cold: 'just researching OR no live website OR no clear use case',
      },
      promptInstructions: `Collect name and email naturally after value is clear.
Ask company name naturally: And what company is this for?
Ask lead volume as: Roughly how many website enquiries do you get per month right now?
Ask budget softly: Are you looking for a small monthly plan or a more hands-on setup with support?
Confirm decision maker: Are you the person who would approve testing Chatflow AI on the website?
Calculate score internally based on scoringRules.
Never tell the visitor their score.
Signal PHASE_2_COMPLETE with score determined.`,
    },

    demo_booking: {
      id: 'demo_booking',
      name: 'Demo Booking',
      description: 'Books a demo call or pilot installation for qualified SaaS leads.',
      phase: 3,
      recommended: true,
      locked: false,
      collectsFields: [
        'meeting_format',
        'preferred_slot',
        'pilot_interest',
      ],
      quickReplies: [],
      triggerKeywords: [],
      scoringRules: null,
      promptInstructions: `HOT leads: offer a demo or free pilot install immediately.
WARM leads: offer a quick product walkthrough and collect email.
COLD leads: offer to send examples, pricing, and setup steps by email.
Ask: Would a quick Zoom call or WhatsApp call work better for you?
Offer exactly 2 available slots.
If calendly_link is available output CALENDLY_BUTTON.
Then output LEAD_DATA.`,
    },

    pricing_plan_advisor: {
      id: 'pricing_plan_advisor',
      name: 'Pricing Plan Advisor',
      description: 'Answers pricing, plan, trial, quota, and upgrade questions, then routes visitors toward the right plan or demo.',
      phase: 1,
      recommended: false,
      locked: false,
      collectsFields: [
        'plan_interest',
        'expected_message_volume',
        'number_of_bots_needed',
      ],
      quickReplies: [],
      triggerKeywords: [
        'pricing',
        'price',
        'cost',
        'plan',
        'plans',
        'monthly',
        'subscription',
        'free trial',
        'trial',
        'credits',
        'messages',
        'upgrade',
      ],
      scoringRules: null,
      promptInstructions: `Answer pricing questions using knowledge base content only.
If exact pricing is unavailable, explain that plans depend on usage and setup needs.
Ask how many website chats or enquiries they expect per month.
Ask whether they need one bot or multiple client/business bots.
Recommend the closest plan only when pricing details are available in the knowledge base.
Always end with: Would you like me to help you choose the best setup for your website?`,
    },

    technical_setup: {
      id: 'technical_setup',
      name: 'Technical Setup',
      description: 'Handles installation, embed, platform, integration, and knowledge base setup questions for SaaS buyers.',
      phase: 2,
      recommended: false,
      locked: false,
      collectsFields: [
        'website_platform',
        'integration_needed',
        'knowledge_sources',
        'technical_contact',
      ],
      quickReplies: [],
      triggerKeywords: [
        'install',
        'installation',
        'embed',
        'script',
        'wordpress',
        'webflow',
        'bubble',
        'shopify',
        'wix',
        'squarespace',
        'integration',
        'integrate',
        'crm',
        'calendar',
        'calendly',
        'api',
        'knowledge base',
        'crawl',
        'website scan',
      ],
      scoringRules: null,
      promptInstructions: `Ask what platform their website is built on.
Explain installation simply: Chatflow AI is added with a small embed script or installed by the team.
Ask whether they need integrations such as CRM, calendar booking, email alerts, or WhatsApp follow-up.
Ask what knowledge sources should train the agent: website pages, FAQs, documents, services, pricing, or policies.
Do not overwhelm the visitor with technical details.
If they want help installing, route to demo_booking or pilot setup.`,
    },
  },
};

if (!AGENT_TEMPLATES.saas_software) {
  AGENT_TEMPLATES.saas_software = SAAS_SOFTWARE_TEMPLATE;
}

export { SAAS_SOFTWARE_TEMPLATE };
