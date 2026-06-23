import { canReceiveLeadEmails, normalizePlan } from './planService.js';

export function shouldSendLeadNotifications(plan) {
  return canReceiveLeadEmails(normalizePlan(plan));
}

export function getNotificationSkipReason(plan) {
  return {
    skipped: true,
    reason: 'lead_notifications_disabled_for_plan',
    plan: normalizePlan(plan),
  };
}
