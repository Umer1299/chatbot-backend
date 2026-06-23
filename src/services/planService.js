export const FREE_PLAN_LEAD_LIMIT = 5;

export const PLAN_DEFINITIONS = {
  free: {
    id: 'free',
    label: 'Free',
    monthlyLeadLimit: FREE_PLAN_LEAD_LIMIT,
    leadEmailAlerts: false,
    description: 'Free plan with up to 5 captured leads per month and no lead email alerts.',
  },
  trial: {
    id: 'trial',
    label: 'Trial',
    monthlyLeadLimit: FREE_PLAN_LEAD_LIMIT,
    leadEmailAlerts: false,
    description: 'Legacy trial plan. Same restrictions as Free.',
    legacy: true,
  },
  professional: {
    id: 'professional',
    label: 'Professional',
    monthlyLeadLimit: null,
    leadEmailAlerts: true,
    description: 'Paid plan with unlimited captured leads and lead email alerts.',
  },
  growth: {
    id: 'growth',
    label: 'Growth',
    monthlyLeadLimit: null,
    leadEmailAlerts: true,
    description: 'Paid growth plan with unlimited captured leads and lead email alerts.',
  },
  agency: {
    id: 'agency',
    label: 'Agency',
    monthlyLeadLimit: null,
    leadEmailAlerts: true,
    description: 'Paid agency plan with unlimited captured leads and lead email alerts.',
  },
};

const PLAN_ALIASES = {
  basic: 'professional',
  pro: 'growth',
  elite: 'agency',
};

const SELECTABLE_PLAN_IDS = ['free', 'professional', 'growth', 'agency'];

export function normalizePlan(plan = 'free') {
  const raw = String(plan || 'free').trim().toLowerCase();
  if (PLAN_DEFINITIONS[raw]) return raw;
  return PLAN_ALIASES[raw] || 'free';
}

export function getPlanDefinition(plan = 'free') {
  return PLAN_DEFINITIONS[normalizePlan(plan)] || PLAN_DEFINITIONS.free;
}

export function isFreePlan(plan = 'free') {
  return ['free', 'trial'].includes(normalizePlan(plan));
}

export function getMonthlyLeadLimit(plan = 'free') {
  return getPlanDefinition(plan).monthlyLeadLimit;
}

export function canReceiveLeadEmails(plan = 'free') {
  return Boolean(getPlanDefinition(plan).leadEmailAlerts);
}

export function listSelectablePlans() {
  return SELECTABLE_PLAN_IDS.map((planId) => getPlanDefinition(planId));
}

export function assertSelectablePlan(plan) {
  const normalized = normalizePlan(plan);
  if (!SELECTABLE_PLAN_IDS.includes(normalized)) {
    const error = new Error('Invalid plan. Allowed plans: ' + SELECTABLE_PLAN_IDS.join(', '));
    error.status = 400;
    throw error;
  }
  return normalized;
}
