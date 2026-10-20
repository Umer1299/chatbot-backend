import { PLAN_HIERARCHY } from "./modelService.js";

// Catalog min_plan is an entitlement, not merely a display hint. Unknown
// plans fail closed instead of being treated as the free tier.
export function agentModelAllowed(businessPlan, minimumPlan) {
  const actual = PLAN_HIERARCHY[businessPlan];
  const required = PLAN_HIERARCHY[minimumPlan];
  return Number.isInteger(actual) && Number.isInteger(required) && actual >= required;
}
