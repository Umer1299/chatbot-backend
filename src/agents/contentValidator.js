import { scrapeLLM } from '../services/aiService.js';
import { cleanAndChunkContent, shouldEmbedChunk } from '../services/firecrawlService.js';
import { upsertSupplementalChunks } from '../db/vectorStore.js';

const REQUIRED_FIELDS = {
  construction: {
    critical: [
      { key: 'services', label: 'Services', category: 'critical', detect: ['roofing', 'foundation', 'driveway', 'renovation', 'construction', 'build', 'contractor'] },
      { key: 'location', label: 'Location', category: 'critical', detect: ['dallas', 'serving', 'area', 'location', 'based in', 'we cover', 'service area'] },
      { key: 'contact_phone', label: 'Contact Phone', category: 'critical', detect: [/\d{3}[-.\s]\d{3}[-.\s]\d{4}/] },
    ],
    important: [
      { key: 'business_name', label: 'Business Name', category: 'important', detect: ['inc', 'llc', 'construction', 'builders', 'contractors', 'company', 'corp'] },
      { key: 'years_experience', label: 'Years Experience', category: 'important', detect: ['years', 'since', 'founded', 'established', 'experience', 'serving since'] },
      { key: 'licensed_insured', label: 'Licensed & Insured', category: 'important', detect: ['licensed', 'insured', 'bonded', 'liability', 'certification', 'accredited'] },
      { key: 'service_hours', label: 'Service Hours', category: 'important', detect: ['monday', 'hours', 'am', 'pm', 'open', 'available', '24/7'] },
      { key: 'emergency', label: 'Emergency Services', category: 'important', detect: ['emergency', 'urgent', '24 hour', 'storm', 'immediate', 'same day'] },
    ],
    optional: [
      { key: 'pricing', label: 'Pricing', category: 'optional', detect: ['price', 'cost', 'estimate', 'quote', 'affordable', 'rates', 'starting from'] },
      { key: 'testimonials', label: 'Testimonials', category: 'optional', detect: ['review', 'testimonial', 'rated', 'satisfied', 'customer said', 'five star'] },
      { key: 'portfolio', label: 'Portfolio', category: 'optional', detect: ['project', 'portfolio', 'completed', 'gallery', 'before and after', 'past work'] },
    ],
  },
  web_agency: {
    critical: [
      { key: 'services', label: 'Services', category: 'critical', detect: ['website', 'design', 'development', 'seo', 'app', 'ecommerce', 'digital'] },
      { key: 'contact_email', label: 'Contact Email', category: 'critical', detect: [/@[\w.-]+\.\w+/] },
      { key: 'location_or_remote', label: 'Location or Remote', category: 'critical', detect: ['remote', 'worldwide', 'uk', 'us', 'london', 'based', 'location', 'global'] },
    ],
    important: [
      { key: 'pricing_packages', label: 'Pricing Packages', category: 'important', detect: ['package', 'price', 'starting from', 'investment', 'plan', 'cost'] },
      { key: 'process', label: 'Process', category: 'important', detect: ['process', 'step', 'discovery', 'phase', 'how we work', 'approach', 'methodology'] },
      { key: 'portfolio', label: 'Portfolio', category: 'important', detect: ['portfolio', 'case study', 'client', 'project', 'work', 'built', 'created'] },
      { key: 'turnaround', label: 'Turnaround', category: 'important', detect: ['week', 'timeline', 'deliver', 'turnaround', 'days', 'months', 'deadline'] },
    ],
    optional: [
      { key: 'team', label: 'Team', category: 'optional', detect: ['team', 'founder', 'developer', 'designer', 'about us', 'meet the team'] },
      { key: 'tech_stack', label: 'Tech Stack', category: 'optional', detect: ['wordpress', 'react', 'shopify', 'webflow', 'figma', 'javascript', 'php', 'laravel'] },
    ],
  },
  real_estate: {
    critical: [
      { key: 'service_area', label: 'Service Area', category: 'critical', detect: ['area', 'location', 'city', 'county', 'covering', 'serving', 'properties in'] },
      { key: 'contact_phone', label: 'Contact Phone', category: 'critical', detect: [/\d{3}[-.\s]\d{3}[-.\s]\d{4}/] },
      { key: 'buy_sell_rent', label: 'Buy/Sell/Rent', category: 'critical', detect: ['buy', 'sell', 'rent', 'let', 'lease', 'property', 'homes', 'houses'] },
    ],
    important: [
      { key: 'agency_name', label: 'Agency Name', category: 'important', detect: ['estate', 'realty', 'property', 'homes', 'real estate', 'lettings'] },
      { key: 'valuation', label: 'Valuation', category: 'important', detect: ['valuation', 'value', 'worth', 'appraisal', 'free', 'assess', 'market value'] },
      { key: 'fees', label: 'Fees', category: 'important', detect: ['fee', 'commission', 'percent', 'no sale', 'fixed fee', 'what we charge'] },
      { key: 'viewing_process', label: 'Viewing Process', category: 'important', detect: ['viewing', 'appointment', 'visit', 'arrange', 'book a viewing', 'show'] },
    ],
    optional: [
      { key: 'testimonials', label: 'Testimonials', category: 'optional', detect: ['review', 'sold', 'happy', 'recommend', 'testimonial', 'client said'] },
      { key: 'market_area', label: 'Market Area', category: 'optional', detect: ['market', 'local', 'neighborhood', 'schools', 'transport', 'community', 'area guide'] },
    ],
  },
  healthcare: {
    critical: [
      { key: 'services', label: 'Services', category: 'critical', detect: ['treatment', 'service', 'condition', 'specialist', 'care', 'health', 'medical', 'clinic'] },
      { key: 'contact_phone', label: 'Contact Phone', category: 'critical', detect: [/\d{3}[-.\s]\d{3}[-.\s]\d{4}/] },
      { key: 'location', label: 'Location', category: 'critical', detect: ['address', 'street', 'located', 'find us', 'directions', 'clinic', 'surgery'] },
      { key: 'emergency_info', label: 'Emergency Info', category: 'critical', detect: ['emergency', 'urgent', '999', '911', 'immediate', 'crisis', 'call 999'] },
    ],
    important: [
      { key: 'opening_hours', label: 'Opening Hours', category: 'important', detect: ['monday', 'hours', 'open', 'closed', 'appointment', 'available', 'surgery hours'] },
      { key: 'insurance', label: 'Insurance', category: 'important', detect: ['insurance', 'nhs', 'private', 'bupa', 'axa', 'covered', 'accepted', 'health plan'] },
      { key: 'booking_process', label: 'Booking Process', category: 'important', detect: ['book', 'appointment', 'call', 'online', 'register', 'new patient'] },
      { key: 'practitioners', label: 'Practitioners', category: 'important', detect: ['doctor', 'dr', 'gp', 'consultant', 'nurse', 'practitioner', 'team', 'staff'] },
    ],
    optional: [
      { key: 'parking', label: 'Parking', category: 'optional', detect: ['parking', 'access', 'disabled', 'transport', 'bus', 'train', 'wheelchair'] },
      { key: 'telehealth', label: 'Telehealth', category: 'optional', detect: ['online', 'video', 'telephone', 'remote', 'virtual', 'telehealth', 'phone consultation'] },
    ],
  },
  law_firm: {
    critical: [
      { key: 'practice_areas', label: 'Practice Areas', category: 'critical', detect: ['family', 'injury', 'criminal', 'employment', 'property', 'immigration', 'corporate', 'law'] },
      { key: 'contact_phone', label: 'Contact Phone', category: 'critical', detect: [/\d{3}[-.\s]\d{3}[-.\s]\d{4}/] },
      { key: 'location', label: 'Location', category: 'critical', detect: ['office', 'located', 'address', 'street', 'find us', 'directions', 'our office'] },
    ],
    important: [
      { key: 'funding', label: 'Funding', category: 'important', detect: ['no win', 'conditional', 'legal aid', 'funding', 'fee', 'cost', 'how we charge'] },
      { key: 'free_consultation', label: 'Free Consultation', category: 'important', detect: ['free', 'initial', 'consultation', 'first meeting', 'no obligation'] },
      { key: 'solicitors', label: 'Solicitors', category: 'important', detect: ['solicitor', 'lawyer', 'partner', 'barrister', 'team', 'our staff', 'meet our'] },
      { key: 'regulatory', label: 'Regulatory', category: 'important', detect: ['sra', 'regulated', 'authorised', 'law society', 'accredited', 'regulated by'] },
    ],
    optional: [
      { key: 'case_results', label: 'Case Results', category: 'optional', detect: ['settlement', 'awarded', 'won', 'result', 'recovered', 'compensation', 'successful'] },
      { key: 'languages', label: 'Languages', category: 'optional', detect: ['language', 'spanish', 'french', 'arabic', 'mandarin', 'speak', 'translation'] },
    ],
  },
};

export async function validateWebsiteContent(industry, scrapedText, analysisResult) {
  const fields = REQUIRED_FIELDS[industry];
  if (!fields) {
    return {
      score: 100,
      missing: {},
      autoGenerated: {},
      hasCriticalGaps: false,
      hasImportantGaps: false,
      totalMissing: 0,
    };
  }

  const lowerText = (scrapedText || '').toLowerCase();
  const missing = { critical: [], important: [], optional: [] };
  let score = 100;

  for (const category of ['critical', 'important', 'optional']) {
    for (const field of fields[category]) {
      const found = field.detect.some((pattern) => {
        if (pattern instanceof RegExp) return pattern.test(scrapedText || '');
        return lowerText.includes(String(pattern).toLowerCase());
      });

      if (!found) {
        missing[category].push({ key: field.key, label: field.label, category: field.category });
        if (category === 'critical') score -= 25;
        if (category === 'important') score -= 10;
        if (category === 'optional') score -= 3;
      }
    }
  }

  score = Math.max(0, score);

  const combinedMissing = [...missing.critical, ...missing.important];
  let autoGenerated = {};

  if (combinedMissing.length > 0) {
    const missingLabels = combinedMissing.map((item) => item.label);
    const missingKeys = combinedMissing.map((item) => item.key);

    try {
      const systemPrompt = `You generate placeholder business information for missing website content.
Return JSON only. No markdown.`;
      const messages = [
        {
          role: 'user',
          content: `Business detected: ${analysisResult?.businessName || 'Unknown Business'}, industry: ${industry}, location: ${analysisResult?.location || ''}, services: ${(analysisResult?.primaryServices || []).join(', ')}.

These fields were NOT found on their website:
${missingLabels.join(', ')}

Generate reasonable placeholder values.
These are AI estimates the owner should verify.
Append (PLEASE VERIFY) to each value.

Return JSON with field keys:
${missingKeys.join(', ')}

Field keys to use: ${missingKeys.join(', ')}`,
        },
      ];
      const options = { maxTokens: 400 };
      const response = await scrapeLLM(systemPrompt, messages, options);

      const cleaned = String(response || '').replace(/```json/gi, '').replace(/```/g, '').trim();
      autoGenerated = JSON.parse(cleaned);
    } catch (error) {
      console.error('Error generating fallback content:', error);
      autoGenerated = {};
    }
  }

  return {
    score,
    missing,
    autoGenerated,
    hasCriticalGaps: missing.critical.length > 0,
    hasImportantGaps: missing.important.length > 0,
    totalMissing: missing.critical.length + missing.important.length,
  };
}

export async function processSupplementalInfo(businessId, content, industry) {
  const fakePages = [
    {
      content,
      url: 'owner-upload',
      title: 'Owner provided information',
      industry,
    },
  ];

  const chunks = cleanAndChunkContent(fakePages);
  const filtered = chunks.filter(shouldEmbedChunk);

  if (filtered.length === 0) {
    return { success: false, message: 'Content too short or low quality' };
  }

  await upsertSupplementalChunks(businessId, filtered, 'owner_upload');

  return {
    success: true,
    chunksAdded: filtered.length,
    message: `Added ${filtered.length} knowledge chunks from your content`,
  };
}

export { REQUIRED_FIELDS };
