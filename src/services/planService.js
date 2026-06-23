export const FREE_PLAN_LEAD_LIMIT = 5;

export const PLAN_DEFINITIONS = {
  free: {
    id: 'free',
    label: 'Free',
    monthlyLeadLimit: FREE_PLAN_LEAD_LIMIT,
    leadEmailAlerts: false,
    description: 'Free plan with up to 5 captured leads per month and no lead email alerts.',
  },
  pro_97: {
    id: 'pro_97',
    label: 'Pro',
    monthlyLeadLimit: null,
    leadEmailAlerts: true,
    description: 'Pro plan with unlimited captured leads and lead email alerts.',
  },
};

const PLAN_ALIASES = {
  trial: 'free',
  professional: 'pro_97',
  growth: 'pro_97',
  agency: 'pro_97',
  basic: 'pro_97',
  pro: 'pro_97',
  elite: 'pro_97',
};

const STORAGE_PLAN_BY_PUBLIC_PLAN = {
  free: 'trial',
  pro_97: 'professional',
};

const SELECTABLE_PLAN_IDS = ['free', 'pro_97'];

export function normalizePlan(plan = 'free') {
  const raw = String(plan || 'free').trim().toLowerCase();
  if (PLAN_DEFINITIONS[raw]) return raw;
  return PLAN_ALIASES[raw] || 'free';
}

export function toStoragePlan(plan = 'free') {
  return STORAGE_PLAN_BY_PUBLIC_PLAN[normalizePlan(plan)] || 'trial';
}

export function getPlanDefinition(plan = 'free') {
  return PLAN_DEFINITIONS[normalizePlan(plan)] || PLAN_DEFINITIONS.free;
}

export function isFreePlan(plan = 'free') {
  return normalizePlan(plan) === 'free';
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
