import { claudeChat } from '../services/aiService.js';

const SAFE_DEFAULT = {
  industry: 'unknown',
  businessName: 'Unknown Business',
  primaryServices: [],
  location: '',
  hasEmergencyServices: false,
  mentionsInsurance: false,
  mentionsRetainer: false,
  mentionsRental: false,
  hasCourtDates: false,
  confidence: 0,
};

export async function detectIndustry(scrapedContent) {
  try {
    const systemPrompt = `You are a business industry classifier.
Analyze website content and return JSON only.
No markdown. No explanation. Raw JSON only.`;
    const messages = [
      {
        role: 'user',
        content: `Analyze this website and return exactly this JSON:
{
  "industry": one of [construction, web_agency, real_estate, healthcare, law_firm, unknown],
  "businessName": string,
  "primaryServices": array of up to 5 strings,
  "location": string or empty string,
  "hasEmergencyServices": boolean,
  "mentionsInsurance": boolean,
  "mentionsRetainer": boolean,
  "mentionsRental": boolean,
  "hasCourtDates": boolean,
  "confidence": number between 0.0 and 1.0
}

Website content (first 3000 characters):
${(scrapedContent || '').substring(0, 3000)}`,
      },
    ];
    const options = { maxTokens: 400 };

    const response = await claudeChat(systemPrompt, messages, options);

    const cleaned = String(response || '')
      .replace(/```json/gi, '')
      .replace(/```/g, '')
      .trim();

    const parsed = JSON.parse(cleaned);
    const normalized = {
      ...SAFE_DEFAULT,
      ...parsed,
      industry: typeof parsed?.industry === 'string' ? parsed.industry : 'unknown',
      businessName:
        typeof parsed?.businessName === 'string' && parsed.businessName.trim()
          ? parsed.businessName
          : 'Unknown Business',
      primaryServices: Array.isArray(parsed?.primaryServices)
        ? parsed.primaryServices.slice(0, 5)
        : [],
      location: typeof parsed?.location === 'string' ? parsed.location : '',
      confidence: Number.isFinite(parsed?.confidence) ? parsed.confidence : 0,
    };

    if (normalized.confidence < 0.5) {
      normalized.industry = 'unknown';
    }

    return normalized;
  } catch (error) {
    console.error('Error detecting industry:', error);
    return { ...SAFE_DEFAULT };
  }
}
