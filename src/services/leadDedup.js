export function normalizeEmail(email) {
  return typeof email === 'string' ? email.trim().toLowerCase() : null;
}

export function shouldUseSessionDedupe({ email, phone }) {
  return !normalizeEmail(email) && !(phone && String(phone).trim());
}

export function pickMostCompleteLead(leads = []) {
  if (!Array.isArray(leads) || leads.length === 0) return null;
  const completeness = (lead) => [
    lead?.full_name,
    lead?.phone,
    lead?.email,
    lead?.company_name,
    lead?.ai_summary,
    lead?.project_details,
    lead?.budget_range,
    lead?.lead_score,
    lead?.urgency_reason
  ].filter(Boolean).length;

  return [...leads].sort((a, b) => {
    const scoreDiff = completeness(b) - completeness(a);
    if (scoreDiff !== 0) return scoreDiff;
    return new Date(b.updated_at || b.created_at || 0).getTime() - new Date(a.updated_at || a.created_at || 0).getTime();
  })[0];
}
