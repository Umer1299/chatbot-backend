const EMAIL_REGEX = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/;
const PHONE_REGEX = /(?:\+?\d[\d\s().-]{7,}\d)/;

const LEAD_SIGNAL_PATTERNS = [
  EMAIL_REGEX,
  PHONE_REGEX,
  /\bmy name is\b/i,
  /\bi\s*am\b/i,
  /\bi['’]m\b/i,
  /\bthis is\b/i,
  /\bfrom\s+[A-Za-z0-9&'\-.\s]{2,80}/i,
  /\bwe need\b/i,
  /\blooking for\b/i,
  /\bquote\b/i,
  /\bbudget\b/i,
  /\blaunch\b/i,
  /\btimeline\b/i,
  /\bbook a call\b/i,
  /\bwebsite\b/i,
  /\bhosting\b/i,
  /\bredesign\b/i,
  /\bsupport\b/i,
  /\bmonthly updates\b/i,
  /\bonline donations?\b/i,
  /\bsermons?\b/i,
  /\bevents?\b/i
];

const NON_LEAD_SHORT_PATTERNS = [/^\s*(hello|hi|hey|thanks|thank you|ok|okay|bye)\s*[!.?]*\s*$/i];

export function shouldRunLeadAgent(message = '', deterministicResult = null) {
  const text = String(message || '').trim();
  if (!text) return false;
  const lower = text.toLowerCase();
  if (/ignore previous|system prompt|jailbreak|developer mode|prompt injection/i.test(lower) && !deterministicResult?.email && !deterministicResult?.phone) return false;
  if (NON_LEAD_SHORT_PATTERNS.some((p) => p.test(text))) return false;
  const hasSignal = LEAD_SIGNAL_PATTERNS.some((pattern) => pattern.test(text));
  if (!hasSignal) return false;
  const extracted = deterministicResult?.extracted || {};
  const missingImportantField = !extracted.fullName || !extracted.budgetRange || !extracted.timeline || !extracted.companyName || !extracted.location || !extracted.serviceNeed;
  return !deterministicResult?.isConfident || missingImportantField;
}

export function extractDeterministicLeadData(message = '') {
  const text = String(message || '').trim();
  if (!text) return { isLead: false, confidence: 0, missingFields: ['emailOrPhone', 'nameOrCompany', 'serviceNeed'], leadSignals: [], extracted: null, isConfident: false };

  const email = (text.match(EMAIL_REGEX) || [null])[0];
  const phone = (text.match(PHONE_REGEX) || [null])[0];
  const nameMatch = text.match(/\b(?:my name is|i am|i['’]m|this is|[A-Za-z][A-Za-z'.-]+\s+[A-Za-z][A-Za-z'.-]+\s+here\s+from)\s+([A-Za-z][A-Za-z\s'.-]{1,60}?)(?=,|\.|\band\b|\bfrom\b|$)/i)
    || text.match(/\b([A-Za-z][A-Za-z'.-]+\s+[A-Za-z][A-Za-z'.-]+)\s+here\s+from\b/i);
  const fromOrgMatch = text.match(/\bfrom\s+([A-Za-z0-9&'\-.\s]{2,80}?)(?=,|\.|\bmy\s+email\s+is\b|\bwe\b|$)/i);

  let organizationRaw = fromOrgMatch?.[1]?.trim() || null;
  let location = null;
  if (organizationRaw) {
    const inLoc = organizationRaw.match(/^(.*?)(?:\s+in\s+)([A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,2})$/);
    if (inLoc) {
      organizationRaw = inLoc[1].trim();
      location = inLoc[2].trim();
    }
  }
  if (!location) {
    const inLocationMatch = text.match(/\bin\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,2})(?=,|\.|$)/);
    location = inLocationMatch?.[1] || null;
  }
  if (!location && organizationRaw) {
    const parts = organizationRaw.trim().split(/\s+/);
    if (parts.length > 1) location = parts[parts.length - 1];
  }

  let serviceNeed = null;
  const needPhrase = text.match(/\b(?:we need|need|looking for|want)\s+(.*?)(?:\.|$)/i);
  if (needPhrase?.[1]) serviceNeed = needPhrase[1].trim().replace(/^help with\s+/i, '');
  const budgetMatch = text.match(/(?:budget\s*(?:is|around|of)?\s*)?([£$€]\s?\d[\d,]*(?:\s?[–-]\s?[£$€]?\s?\d[\d,]*)?)/i);
  const timelineMatch = text.match(/\b(within\s+\d+\s+(?:day|days|week|weeks|month|months|year|years)|in\s+\d+\s+(?:day|days|week|weeks|month|months|year|years)|before\s+[A-Za-z]+|by\s+[A-Za-z]+|asap|immediately|urgent)\b/i);

  const churchName = organizationRaw;
  const shouldHotScore = Boolean((email || phone) && (serviceNeed || timelineMatch?.[1] || budgetMatch?.[1]));
  const extracted = {
    name: nameMatch?.[1]?.trim() || null,
    fullName: nameMatch?.[1]?.trim() || null,
    email: email || null,
    phone: phone || null,
    churchName,
    company_name: churchName,
    companyName: churchName,
    location: location || null,
    serviceNeed: serviceNeed || null,
    budgetRange: budgetMatch?.[1]?.replace(/\s+/g, ' ').trim() || null,
    timeline: timelineMatch?.[1] || null,
    score_reasons: ['deterministic_extraction'],
    lead_score: shouldHotScore || /(urgent|asap|immediately)/i.test(text) ? 'hot' : 'warm'
  };

  const leadSignals = LEAD_SIGNAL_PATTERNS.filter((p) => p.test(text)).map((p) => p.toString());
  const hasContact = Boolean(extracted.email || extracted.phone);
  const hasIdentity = Boolean(extracted.churchName || extracted.name);
  const hasNeed = Boolean(extracted.serviceNeed);
  const isConfident = hasContact && hasIdentity && hasNeed;
  const confidence = isConfident ? 0.9 : (hasContact && (hasIdentity || hasNeed) ? 0.65 : (leadSignals.length ? 0.35 : 0));
  const missingFields = [];
  if (!hasContact) missingFields.push('emailOrPhone');
  if (!hasIdentity) missingFields.push('nameOrCompany');
  if (!hasNeed) missingFields.push('serviceNeed');

  return { isLead: hasContact || (hasIdentity && hasNeed), confidence, missingFields, leadSignals, extracted: (hasContact || hasIdentity || hasNeed) ? extracted : null, isConfident };
}
