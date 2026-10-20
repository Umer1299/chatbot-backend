import { canReceiveLeadEmails } from './planService.js';
export function applyChatEmailPolicy(config) {
  if (!config || canReceiveLeadEmails(config.plan)) return config;
  return {
    ...config,
    owner_email: null,
    escalation_email: null,
    lead_email_alerts_enabled: false,
  };
}
