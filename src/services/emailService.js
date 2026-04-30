export async function sendLeadAlert(config, payload) {
  console.log('sendLeadAlert queued', {
    businessId: config?.business_id,
    leadId: payload?.id,
  });
}

export async function sendUrgentEscalation(config, sessionId, message) {
  console.log('sendUrgentEscalation queued', {
    businessId: config?.business_id,
    sessionId,
    preview: String(message || '').slice(0, 80),
  });
}

export async function sendFollowUpReminder() {}
export async function sendMonthlyReport() {}
