const AGENT_TEMPLATES = {
  construction: {
    industryName: 'Construction',
    emoji: '🏗️',
    agents: {
      quote_request: {
        id: 'quote_request',
        name: 'Quote Request',
        description: 'Collects the core project details needed to start a construction quote request.',
        phase: 1,
        recommended: true,
        locked: false,
        collectsFields: [
          'project_type',
          'residential_or_commercial',
          'project_location',
          'timeline',
        ],
        quickReplies: [
          'Roofing',
          'Foundation',
          'Driveway',
          'Renovation',
          'New Build',
          'Other',
        ],
        triggerKeywords: [],
        scoringRules: null,
        promptInstructions: `Ask project type first using quick reply options.
Then ask residential or commercial.
Then ask location.
Then ask timeline.
NEVER ask about budget in this phase.
If visitor says emergency, urgent, storm damage, flooding, or collapsed: set urgency_flag to true, skip remaining discovery questions, and move immediately to qualification phase.
When you have all 4 fields signal PHASE_1_COMPLETE.`,
      },

      lead_qualification: {
        id: 'lead_qualification',
        name: 'Lead Qualification',
        description: 'Qualifies construction leads by collecting contact, budget, insurance, decision-maker, and scoring information.',
        phase: 2,
        recommended: true,
        locked: false,
        collectsFields: [
          'contact_name',
          'contact_phone',
          'budget_range',
          'has_insurance',
          'is_decision_maker',
          'lead_score',
        ],
        quickReplies: [],
        triggerKeywords: [],
        scoringRules: {
          hot: 'decision maker confirmed AND budget stated AND urgent timeline',
          warm: 'decision maker confirmed but vague budget OR flexible timeline',
          cold: 'not decision maker OR no budget OR just browsing',
        },
        promptInstructions: `Collect name and phone naturally mid-conversation.
Do not ask them in a row like a form.
Ask budget as: Do you have a rough budget in mind or would you prefer we assess and give options?
Ask insurance as: Are you working with an insurance claim on this?
Confirm decision maker: And you are the homeowner or property owner on this?
Calculate score internally based on scoringRules.
Never tell the visitor their score.
Signal PHASE_2_COMPLETE with score determined.`,
      },

      site_visit_booking: {
        id: 'site_visit_booking',
        name: 'Site Visit Booking',
        description: 'Books construction site visits based on lead quality and availability.',
        phase: 3,
        recommended: true,
        locked: false,
        collectsFields: [
          'appointment_date',
          'appointment_time',
          'site_address',
          'contact_email',
        ],
        quickReplies: [],
        triggerKeywords: [],
        scoringRules: null,
        promptInstructions: `HOT lead: offer exactly 2 time slots from availability.
WARM lead: offer 2 slots OR promise callback in 24hrs.
COLD lead: collect email only.
Say: I will send you our project guide and pricing info.
Never offer more than 2 slot options at once.
Always confirm the full site address separately.
Collect email last for confirmation.
End with a complete appointment summary.
If calendly_link is available output CALENDLY_BUTTON.
Then output LEAD_DATA marker.`,
      },

      emergency_response: {
        id: 'emergency_response',
        name: 'Emergency Response',
        description: 'Overrides the normal flow for urgent construction emergencies and captures only critical contact details.',
        phase: 1,
        recommended: false,
        locked: false,
        collectsFields: [
          'emergency_type',
          'contact_name',
          'contact_phone',
          'site_address',
        ],
        quickReplies: [],
        triggerKeywords: [
          'emergency',
          'storm damage',
          'flooding',
          'structural damage',
          'roof collapsed',
          'urgent repair',
          'fallen tree',
          '24 hour',
          'right now',
          'tonight',
          'burst pipe',
        ],
        scoringRules: null,
        promptInstructions: `When any trigger keyword detected in visitor message:
Immediately switch to emergency mode.
Skip ALL normal phase questions.
Collect only: what happened, name, phone, address.
Promise: Our team will call you within 30 minutes.
Set urgency_flag to true automatically.
Set lead_score to hot automatically.
Output LEAD_DATA immediately after address collected.
Do not continue to any other phase.`,
      },

      compliance_permit: {
        id: 'compliance_permit',
        name: 'Compliance Permit',
        description: 'Answers permit and compliance questions using knowledge base content only, then routes back to quote flow.',
        phase: 1,
        recommended: false,
        locked: false,
        collectsFields: ['question_topic'],
        quickReplies: [],
        triggerKeywords: [
          'permit',
          'planning permission',
          'compliance',
          'regulation',
          'licensed',
          'bonded',
          'certification',
          'code',
        ],
        scoringRules: null,
        promptInstructions: `Answer permit and compliance questions using knowledge base content only.
Never give specific legal or regulatory advice.
Keep answers factual and brief.
Always end every answer with:
Would you like to get a quote for your project?
I can help with that right now.
Then return to normal Phase 1 flow.`,
      },
    },
  },

  web_agency: {
    industryName: 'Web Agency',
    emoji: '💻',
    agents: {
      discovery: {
        id: 'discovery',
        name: 'Discovery',
        description: 'Collects initial web project goals, current situation, project type, and timeline.',
        phase: 1,
        recommended: true,
        locked: false,
        collectsFields: [
          'project_type',
          'current_situation',
          'primary_goal',
          'timeline',
        ],
        quickReplies: [
          'New Website',
          'Redesign Existing Site',
          'E-commerce Store',
          'Web App',
          'Other',
        ],
        triggerKeywords: [],
        scoringRules: null,
        promptInstructions: `Start with project type using quick replies.
Then ask about their current situation.
Focus on GOALS not features.
Wrong: Do you need a contact form?
Right: What is the main thing you want your new site to do for your business?
Never ask about budget in Phase 1.
Signal PHASE_1_COMPLETE when all 4 collected.`,
      },

      budget_qualification: {
        id: 'budget_qualification',
        name: 'Budget Qualification',
        description: 'Qualifies web agency leads by investment range, decision-maker status, company details, and timeline.',
        phase: 2,
        recommended: true,
        locked: false,
        collectsFields: [
          'budget_range',
          'contact_name',
          'contact_email',
          'contact_phone',
          'is_decision_maker',
          'company_name',
          'lead_score',
        ],
        quickReplies: [],
        triggerKeywords: [],
        scoringRules: {
          hot: 'budget $5000+ AND decision maker AND timeline within 3 months',
          warm: 'budget $2000-5000 OR decision maker unclear',
          cold: 'budget under $2000 OR just researching',
        },
        promptInstructions: `Ask budget as: To point you to the right package do you have a rough investment range in mind?
If they say not sure give options:
Most projects fall into: Under $3k / $3k-$8k / $8k-$20k / $20k+ — which feels closest?
Agencies prefer email over phone so ask email first.
Ask company name naturally: And what company is this for?
Signal PHASE_2_COMPLETE when all fields collected.`,
      },

      discovery_call: {
        id: 'discovery_call',
        name: 'Discovery Call',
        description: 'Books a quick discovery call for web agency leads or captures email for cold leads.',
        phase: 3,
        recommended: true,
        locked: false,
        collectsFields: ['meeting_format', 'preferred_slot'],
        quickReplies: [],
        triggerKeywords: [],
        scoringRules: null,
        promptInstructions: `Ask: Would a Zoom call or phone call work better for you?
Offer exactly 2 available slots.
Never say schedule a meeting — say jump on a quick call.
COLD leads: Let me send you our recent work and pricing guide. Collect email only.
If calendly_link available output CALENDLY_BUTTON.
Then output LEAD_DATA.`,
      },

      scope_clarification: {
        id: 'scope_clarification',
        name: 'Scope Clarification',
        description: 'Activates for complex web projects to clarify CMS preference, integrations, and branding.',
        phase: 2,
        recommended: false,
        locked: false,
        collectsFields: [
          'cms_preference',
          'integrations_needed',
          'has_existing_branding',
        ],
        quickReplies: [],
        triggerKeywords: [
          'web app',
          'ecommerce',
          'integrations',
          'custom build',
          'database',
          'API',
          'complex',
          'portal',
        ],
        scoringRules: null,
        promptInstructions: `Only activate for complex project types.
Simple brochure sites skip this agent entirely.
Ask: Do you have a preference for the platform or open to our recommendation?
Ask: Will this need to connect to any other tools like a CRM or payment system?
Do not add friction — keep questions conversational.`,
      },

      retainer_qualification: {
        id: 'retainer_qualification',
        name: 'Retainer Qualification',
        description: 'Qualifies ongoing SEO, maintenance, content, and marketing retainer opportunities.',
        phase: 2,
        recommended: false,
        locked: false,
        collectsFields: [
          'retainer_type',
          'current_monthly_spend',
          'timeline_to_start',
        ],
        quickReplies: [],
        triggerKeywords: [
          'SEO',
          'ongoing',
          'monthly',
          'maintenance',
          'marketing retainer',
          'content',
          'social media management',
        ],
        scoringRules: null,
        promptInstructions: `Shift tone to partnership language.
Ask: Are you looking for a one-time project or an ongoing growth partnership?
Ask monthly spend: Do you have a monthly budget set aside or are you building the business case?`,
      },
    },
  },

  real_estate: {
    industryName: 'Real Estate',
    emoji: '🏠',
    agents: {
      property_inquiry: {
        id: 'property_inquiry',
        name: 'Property Inquiry',
        description: 'Captures real estate visitor intent and basic property requirements.',
        phase: 1,
        recommended: true,
        locked: false,
        collectsFields: [
          'intent',
          'property_type',
          'location_preference',
          'bedrooms',
          'must_have_features',
        ],
        quickReplies: [
          'Buying a Property',
          'Renting',
          'Selling My Home',
          'Commercial',
          'Investment Property',
        ],
        triggerKeywords: [],
        scoringRules: null,
        promptInstructions: `Start with intent using quick replies.
Buying: route to buyer_qualification agent.
Renting: route to rental_inquiry agent.
Selling: route to seller_lead agent.
Never mix intents in the same conversation.
Signal PHASE_1_COMPLETE when intent and basic property requirements collected.`,
      },

      buyer_qualification: {
        id: 'buyer_qualification',
        name: 'Buyer Qualification',
        description: 'Qualifies buyers by budget, pre-approval, timeline, and contact details.',
        phase: 2,
        recommended: true,
        locked: false,
        collectsFields: [
          'budget_range',
          'is_pre_approved',
          'timeline_to_buy',
          'is_first_time_buyer',
          'contact_name',
          'contact_phone',
          'lead_score',
        ],
        quickReplies: [],
        triggerKeywords: [],
        scoringRules: {
          hot: 'pre-approved AND clear budget AND buying within 3 months',
          warm: 'interested but not pre-approved OR flexible',
          cold: 'browsing, no budget clarity, 12+ months away',
        },
        promptInstructions: `Ask pre-approval naturally:
Have you spoken to a mortgage advisor yet or are you still in the early stages?
Never make visitor feel judged for not being pre-approved. Say: No problem at all we work with buyers at every stage.
This is the most important qualifying question in real estate.`,
      },

      viewing_booking: {
        id: 'viewing_booking',
        name: 'Viewing Booking',
        description: 'Books viewings for hot and warm property leads or sets alerts for cold leads.',
        phase: 3,
        recommended: true,
        locked: false,
        collectsFields: [
          'viewing_date',
          'viewing_time',
          'contact_email',
          'specific_property_interest',
        ],
        quickReplies: [],
        triggerKeywords: [],
        scoringRules: null,
        promptInstructions: `HOT: Book viewing immediately with 2 slot options.
WARM: Book viewing OR send property matches by email.
COLD: Let me set up property alerts for you.
Collect email for alerts.
If calendly_link available output CALENDLY_BUTTON.
Then output LEAD_DATA.`,
      },

      seller_lead: {
        id: 'seller_lead',
        name: 'Seller Lead',
        description: 'Handles seller enquiries by offering valuation and collecting property details.',
        phase: 2,
        recommended: false,
        locked: false,
        collectsFields: [
          'property_address',
          'property_type',
          'estimated_value',
          'timeline_to_sell',
          'contact_name',
          'contact_phone',
        ],
        quickReplies: [],
        triggerKeywords: [
          'sell',
          'selling',
          'valuation',
          'value my home',
          'list my property',
          'market appraisal',
        ],
        scoringRules: null,
        promptInstructions: `Sellers need valuation first not a sales pitch.
Say: We can arrange a free property valuation no obligation at all.
Ask timeline: Looking to sell in the next few months or planning ahead?
Always book a valuation appointment as the outcome.`,
      },

      rental_inquiry: {
        id: 'rental_inquiry',
        name: 'Rental Inquiry',
        description: 'Handles rental enquiries and captures move-in, budget, lease, pets, and contact details.',
        phase: 2,
        recommended: false,
        locked: false,
        collectsFields: [
          'monthly_budget',
          'move_in_date',
          'lease_length_preference',
          'has_pets',
          'contact_name',
          'contact_phone',
        ],
        quickReplies: [],
        triggerKeywords: [
          'rent',
          'renting',
          'tenant',
          'monthly rent',
          'lease',
          'looking to rent',
          'rental',
        ],
        scoringRules: null,
        promptInstructions: `Renters move faster than buyers.
Move-in date is the most important field.
If move-in within 2 weeks set lead_score to hot.
Always ask about pets: it filters properties and saves agent time.`,
      },
    },
  },

  healthcare: {
    industryName: 'Healthcare',
    emoji: '🏥',
    agents: {
      urgent_triage: {
        id: 'urgent_triage',
        name: 'Urgent Triage',
        description: 'Always-on static urgent safety triage that bypasses AI generation for emergency symptoms.',
        phase: 0,
        recommended: true,
        locked: true,
        collectsFields: [],
        quickReplies: [],
        triggerKeywords: [
          'chest pain',
          'cant breathe',
          'cannot breathe',
          'difficulty breathing',
          'unconscious',
          'overdose',
          'suicidal',
          'suicide',
          'stroke',
          'severe bleeding',
          'collapsed',
          'heart attack',
          'seizure',
          'not responsive',
          'dying',
          'life threatening',
          'emergency',
        ],
        scoringRules: null,
        promptInstructions: `THIS AGENT USES HARDCODED STATIC RESPONSE ONLY.
NO AI GENERATION EVER FOR THIS AGENT.
The static response is injected directly by the backend before any AI call.
Backend detects trigger keywords in message.
Backend sends static response immediately.
Backend logs URGENT_ESCALATION.
Backend emails clinic owner with URGENT prefix.
Backend marks session as escalated.
Normal conversation flow stops completely.`,
      },

      appointment_booking: {
        id: 'appointment_booking',
        name: 'Appointment Booking',
        description: 'Books non-urgent healthcare appointments without asking for diagnosis or giving medical advice.',
        phase: 1,
        recommended: true,
        locked: false,
        collectsFields: [
          'appointment_reason',
          'preferred_date',
          'preferred_time',
          'new_or_returning',
          'contact_name',
          'contact_phone',
        ],
        quickReplies: [
          'General Checkup',
          'Follow-up Visit',
          'New Patient',
          'Specialist Referral',
          'Other',
        ],
        triggerKeywords: [],
        scoringRules: null,
        promptInstructions: `Ask reason in general category terms only.
NEVER ask for specific symptoms or diagnosis.
NEVER give any medical opinion whatsoever.
If visitor describes detailed symptoms say:
I understand you are experiencing some discomfort.
I am not able to assess symptoms here.
The best thing is to speak directly with our team.
Let me get you booked in.
Then redirect to booking immediately.
Signal PHASE_1_COMPLETE when basics collected.`,
      },

      patient_intake: {
        id: 'patient_intake',
        name: 'Patient Intake',
        description: 'Collects safe new-patient intake details such as patient type, insurance provider, referral source, and email.',
        phase: 2,
        recommended: true,
        locked: false,
        collectsFields: [
          'patient_type',
          'insurance_provider',
          'referral_source',
          'contact_email',
        ],
        quickReplies: [],
        triggerKeywords: [],
        scoringRules: null,
        promptInstructions: `For new patients: Are you covered by insurance for this visit or will you be self-paying?
Ask insurance provider name only.
NEVER ask for policy numbers in chat.
Collect email for appointment confirmation.
Signal PHASE_2_COMPLETE when done.`,
      },

      service_information: {
        id: 'service_information',
        name: 'Service Information',
        description: 'Answers healthcare service questions using knowledge base content only.',
        phase: 1,
        recommended: false,
        locked: false,
        collectsFields: [],
        quickReplies: [],
        triggerKeywords: [
          'what services',
          'do you offer',
          'do you treat',
          'what conditions',
          'what do you specialise in',
          'opening hours',
          'do you accept',
          'insurance accepted',
        ],
        scoringRules: null,
        promptInstructions: `Answer from knowledge base content only.
Never speculate about services not found in knowledge base.
Keep answers brief and factual.
Always end with: Would you like to book an appointment?
I can get that sorted right now.`,
      },

      specialist_referral: {
        id: 'specialist_referral',
        name: 'Specialist Referral',
        description: 'Routes specialist or referral questions into the correct appointment booking path.',
        phase: 1,
        recommended: false,
        locked: false,
        collectsFields: ['department_needed', 'referral_type'],
        quickReplies: [],
        triggerKeywords: [
          'specialist',
          'referred',
          'referral',
          'department',
          'consultant',
          'which doctor',
          'which team',
        ],
        scoringRules: null,
        promptInstructions: `Ask: Are you being referred by another doctor or coming directly to us?
Match visitor need to correct department.
Then hand to appointment_booking agent with department field pre-filled.`,
      },
    },
  },

  law_firm: {
    industryName: 'Law Firm',
    emoji: '⚖️',
    agents: {
      case_inquiry: {
        id: 'case_inquiry',
        name: 'Case Inquiry',
        description: 'Collects legal area, brief case description, urgency, and jurisdiction without giving legal advice.',
        phase: 1,
        recommended: true,
        locked: false,
        collectsFields: [
          'legal_area',
          'case_description',
          'urgency_level',
          'jurisdiction_location',
        ],
        quickReplies: [
          'Family Law',
          'Personal Injury',
          'Criminal Defense',
          'Employment Law',
          'Business & Corporate',
          'Other',
        ],
        triggerKeywords: [],
        scoringRules: null,
        promptInstructions: `Never give any legal opinion or advice.
Never say you have a strong case.
Never say you should do X legally.
Collect legal area first using quick replies.
Ask brief case description:
Could you give me a brief overview of your situation?
Just a sentence or two so I can connect you with the right solicitor.
Ask urgency: Is there a deadline or court date involved?
Court date within 30 days = set lead_score hot automatically regardless of other factors.
End every response with: I am not able to provide legal advice here but our solicitors absolutely can.
Signal PHASE_1_COMPLETE when area and brief description collected.`,
      },

      client_qualification: {
        id: 'client_qualification',
        name: 'Client Qualification',
        description: 'Qualifies legal leads by contact details, representation status, case stage, funding preference, and score.',
        phase: 2,
        recommended: true,
        locked: false,
        collectsFields: [
          'contact_name',
          'contact_phone',
          'contact_email',
          'has_existing_lawyer',
          'case_stage',
          'funding_preference',
          'lead_score',
        ],
        quickReplies: [],
        triggerKeywords: [],
        scoringRules: {
          hot: 'court date pending AND no current lawyer AND clear case type AND funding decided',
          warm: 'clear case type but no urgency OR has existing lawyer but seeking second opinion',
          cold: 'very early stage just researching',
        },
        promptInstructions: `Conflict check is critical for law firms:
Are you currently represented by another solicitor?
If yes: still collect all details and flag has_existing_lawyer as true for firm to assess.
Ask funding naturally:
Are you aware of how you would like to fund this — no-win-no-fee, private pay, or unsure at this stage?
Signal PHASE_2_COMPLETE with score determined.`,
      },

      consultation_booking: {
        id: 'consultation_booking',
        name: 'Consultation Booking',
        description: 'Books legal consultations or captures email for cold leads.',
        phase: 3,
        recommended: true,
        locked: false,
        collectsFields: ['consultation_slot', 'consultation_format'],
        quickReplies: [],
        triggerKeywords: [],
        scoringRules: null,
        promptInstructions: `Offer: Would you prefer phone, video or in-person?
If firm offers free initial consultation always say:
Your first consultation is completely free and without any obligation whatsoever.
This dramatically improves conversion rate.
COLD leads: Let me send you our free legal guide on [their legal area]. Collect email only.
If calendly_link available output CALENDLY_BUTTON.
Then output LEAD_DATA.`,
      },

      urgency_court_date: {
        id: 'urgency_court_date',
        name: 'Urgency Court Date',
        description: 'Overrides normal legal flow for urgent court dates, hearings, injunctions, arrests, and deadlines.',
        phase: 1,
        recommended: false,
        locked: false,
        collectsFields: [
          'court_date',
          'case_type',
          'contact_name',
          'contact_phone',
        ],
        quickReplies: [],
        triggerKeywords: [
          'court date',
          'hearing tomorrow',
          'deadline',
          'arrested',
          'injunction',
          'restraining order',
          'urgent legal',
          'today',
          'this week',
          'immediate legal help',
          'bail',
        ],
        scoringRules: null,
        promptInstructions: `When triggered skip all normal phase questions.
Collect court date and phone number only.
Say: This sounds time-sensitive. Let me get your number and have a solicitor call you back within the hour.
Set lead_score to hot automatically.
Set urgency_flag to true.
Email firm owner immediately with URGENT prefix.
Output LEAD_DATA immediately.`,
      },

      legal_document: {
        id: 'legal_document',
        name: 'Legal Document',
        description: 'Handles legal document enquiries while avoiding legal opinions about document content.',
        phase: 1,
        recommended: false,
        locked: false,
        collectsFields: ['document_type', 'timeline_needed'],
        quickReplies: [],
        triggerKeywords: [
          'contract',
          'document review',
          'agreement',
          'draft contract',
          'will',
          'deed',
          'nda',
          'non-disclosure',
          'terms and conditions',
          'lease agreement',
        ],
        scoringRules: null,
        promptInstructions: `Keep strictly to document types and turnaround times from the knowledge base.
Never comment on the legal content of documents.
Never give opinions on whether terms are fair.
Always end with an offer to book a consultation.`,
      },
    },
  },
};

export { AGENT_TEMPLATES };
