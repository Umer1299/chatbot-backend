export function normalizePhone(phone) {
  if (!phone) return null;
  const digits = String(phone).replace(/\D+/g, '');
  return digits || null;
}

export function determineLeadMatchStrategy({ hasEmail, hasPhone, hasSessionId }) {
  if (hasEmail) return 'business_id+email';
  if (hasPhone) return 'business_id+phone';
  if (hasSessionId) return 'business_id+session_id';
  return 'none';
}

export function buildFinalLeadPayload(existingLead, incomingLead, industryDataPatch = {}) {
  const full_name = existingLead?.full_name || incomingLead?.name || incomingLead?.fullName || null;
  const email = existingLead?.email || incomingLead?.email || null;
  const company_name = existingLead?.company_name || incomingLead?.companyName || incomingLead?.company_name || incomingLead?.churchName || null;
  const mergedIndustryData = {
    ...(existingLead?.industry_data || {}),
    ...industryDataPatch,
    name: full_name,
    fullName: full_name,
    email,
    companyName: company_name,
    company_name
  };
  return {
    full_name,
    phone: existingLead?.phone || incomingLead?.phone || null,
    email,
    company_name,
    lead_score: existingLead?.lead_score || incomingLead?.lead_score || 'warm',
    score_reasons: Array.isArray(existingLead?.score_reasons) && existingLead.score_reasons.length ? existingLead.score_reasons : (incomingLead?.score_reasons || []),
    ai_summary: existingLead?.ai_summary || incomingLead?.ai_summary || null,
    project_details: existingLead?.project_details || incomingLead?.project_details || null,
    industry_data: mergedIndustryData
  };
}

export function checkIndustryDataConsistency(lead) {
  const industryData = lead?.industry_data || {};
  const matchesEmail = !industryData.email || !lead?.email || String(industryData.email).toLowerCase() === String(lead.email).toLowerCase();
  const matchesName = !industryData.name || !lead?.full_name || industryData.name === lead.full_name;
  const matchesCompany = !industryData.companyName || !lead?.company_name || industryData.companyName === lead.company_name;
  return matchesEmail && matchesName && matchesCompany;
}
