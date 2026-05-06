import { Resend } from 'resend';

let resendClient = null;

function getResendClient() {
  if (!process.env.RESEND_API_KEY) {
    console.warn('RESEND_API_KEY is not configured. Email not sent.');
    return null;
  }

  if (!resendClient) {
    resendClient = new Resend(process.env.RESEND_API_KEY);
  }

  return resendClient;
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function getDashboardBaseUrl() {
  return process.env.BUBBLE_APP_URL || process.env.BUBBLE_API_URL || '';
}

function toSafeUrl(url) {
  return escapeHtml(String(url || '').replace(/\/+$/, ''));
}

function canSendEmail(context) {
  if (!process.env.RESEND_API_KEY) {
    console.log(`[emailService] RESEND_API_KEY missing. Skipping ${context}.`);
    return false;
  }
  return true;
}

export async function sendLeadAlert(config, lead) {
  if (!canSendEmail('sendLeadAlert')) return { skipped: true, reason: 'RESEND_API_KEY missing' };
  const resend = getResendClient();
  if (!resend) return { skipped: true, reason: 'RESEND_API_KEY missing' };

  const scoreEmoji = { hot: '🔥', warm: '⚡', cold: '❄️' };
  const scoreLabel = { hot: 'HOT LEAD', warm: 'WARM LEAD', cold: 'COLD LEAD' };
  const emoji = scoreEmoji[lead?.lead_score] || '📋';
  const label = scoreLabel[lead?.lead_score] || 'NEW LEAD';
  const recipient = config?.escalation_email || config?.owner_email;
  const dateText = new Date().toLocaleDateString('en-US');
  const dashboardBase = toSafeUrl(getDashboardBaseUrl());
  const leadId = encodeURIComponent(String(lead?.id ?? ''));
  const dashboardLink = `${dashboardBase}/lead-detail?id=${leadId}`;
  const reasons = Array.isArray(lead?.score_reasons) ? lead.score_reasons : [];

  const htmlString = `
    <div style="font-family:Arial,sans-serif;line-height:1.5;color:#111827;max-width:640px;margin:0 auto;border:1px solid #e5e7eb;">
      <div style="background:#6366f1;color:white;padding:16px 20px;font-weight:700;font-size:18px;">
        ${emoji} ${escapeHtml(label)} — ${escapeHtml(config?.business_name || 'Your Business')}
      </div>

      <div style="padding:20px;">
        <div style="background:#f3f4f6;border-radius:8px;padding:14px;margin-bottom:16px;">
          <div style="font-size:12px;font-weight:700;color:#6b7280;margin-bottom:6px;">AI SUMMARY</div>
          <div>${escapeHtml(lead?.ai_summary || 'No summary provided.')}</div>
        </div>

        <table style="width:100%;border-collapse:collapse;margin-bottom:16px;">
          <tr><td style="padding:6px 0;font-weight:600;width:120px;">Name:</td><td>${escapeHtml(lead?.full_name || 'Not provided')}</td></tr>
          <tr><td style="padding:6px 0;font-weight:600;">Phone:</td><td><a href="tel:${escapeHtml(lead?.phone || '')}">${escapeHtml(lead?.phone || 'Not provided')}</a></td></tr>
          <tr><td style="padding:6px 0;font-weight:600;">Email:</td><td><a href="mailto:${escapeHtml(lead?.email || '')}">${escapeHtml(lead?.email || 'Not provided')}</a></td></tr>
          ${lead?.budget_range ? `<tr><td style="padding:6px 0;font-weight:600;">Budget:</td><td>${escapeHtml(lead.budget_range)}</td></tr>` : ''}
        </table>

        <div style="border:1px solid #e5e7eb;border-radius:8px;padding:14px;margin-bottom:16px;">
          <div style="font-size:12px;font-weight:700;color:#6b7280;margin-bottom:6px;">PROJECT DETAILS</div>
          <div>${escapeHtml(lead?.project_details || 'Not provided')}</div>
        </div>

        ${lead?.urgency_flag ? '<div style="background:#fee2e2;color:#991b1b;padding:12px;border-radius:8px;margin-bottom:16px;font-weight:600;">🚨 URGENT — This lead has been flagged as urgent</div>' : ''}

        ${reasons.length ? `<div style="margin-bottom:16px;"><div style="font-size:12px;font-weight:700;color:#6b7280;margin-bottom:6px;">WHY THIS SCORE</div><ul style="padding-left:18px;margin:0;">${reasons.map((reason) => `<li>${escapeHtml(reason)}</li>`).join('')}</ul></div>` : ''}

        <div style="text-align:center;margin:24px 0 10px;">
          <a href="${dashboardLink}" style="background:#6366f1;color:white;text-decoration:none;padding:12px 18px;border-radius:8px;font-weight:700;display:inline-block;">View Full Lead in Dashboard →</a>
        </div>
      </div>

      <div style="padding:12px 20px;color:#6b7280;font-size:12px;border-top:1px solid #e5e7eb;">
        Sent by ChatflowAI • ${escapeHtml(dateText)}
      </div>
    </div>
  `;

  await resend.emails.send({
    from: 'ChatflowAI Alerts <alerts@chatflowai.com>',
    to: recipient,
    subject: `${emoji} ${label} — ${lead?.full_name || 'New visitor'} | ${String(lead?.project_details || '').substring(0, 60)}`,
    html: htmlString,
  });
}

export async function sendUrgentEscalation(config, sessionId, message) {
  if (!canSendEmail('sendUrgentEscalation')) return { skipped: true, reason: 'RESEND_API_KEY missing' };
  const resend = getResendClient();
  if (!resend) return { skipped: true, reason: 'RESEND_API_KEY missing' };

  const nowText = new Date().toLocaleString('en-US');
  const dashboardBase = toSafeUrl(getDashboardBaseUrl());
  const dashboardLink = `${dashboardBase}/lead-detail?id=${encodeURIComponent(String(sessionId || ''))}`;

  const htmlString = `
    <div style="font-family:Arial,sans-serif;line-height:1.5;color:#111827;max-width:640px;margin:0 auto;border:1px solid #e5e7eb;">
      <div style="background:#dc2626;color:white;padding:16px 20px;font-weight:700;font-size:18px;">🚨 URGENT: Customer needs immediate help</div>
      <div style="padding:20px;">
        <p>A visitor on the ${escapeHtml(config?.business_name || 'business')} chatbot sent a message that triggered the escalation alert.</p>
        <p>Their message:</p>
        <blockquote style="margin:0 0 14px;padding:12px 14px;background:#f9fafb;border-left:4px solid #ef4444;">${escapeHtml(message || '')}</blockquote>
        <p><strong>Session ID:</strong> ${escapeHtml(sessionId || 'N/A')}<br/><strong>Time:</strong> ${escapeHtml(nowText)}</p>
        <p><strong>Action required:</strong> Check if contact info was collected and call them immediately.</p>
        <p style="margin-top:20px;"><a href="${dashboardLink}" style="background:#dc2626;color:white;text-decoration:none;padding:10px 14px;border-radius:8px;font-weight:700;display:inline-block;">View in Dashboard →</a></p>
      </div>
    </div>
  `;

  await resend.emails.send({
    from: 'ChatflowAI Alerts <alerts@chatflowai.com>',
    to: config?.escalation_email || config?.owner_email,
    subject: `🚨 URGENT: Customer needs immediate help — ${config?.business_name || 'Business'}`,
    html: htmlString,
  });
}

export async function sendFollowUpReminder(lead, recipientEmail) {
  if (!canSendEmail('sendFollowUpReminder')) return { skipped: true, reason: 'RESEND_API_KEY missing' };
  const resend = getResendClient();
  if (!resend) return { skipped: true, reason: 'RESEND_API_KEY missing' };

  const dashboardBase = toSafeUrl(getDashboardBaseUrl());
  const dashboardLink = `${dashboardBase}/lead-detail?id=${encodeURIComponent(String(lead?.id || ''))}`;

  const htmlString = `
    <div style="font-family:Arial,sans-serif;line-height:1.5;color:#111827;max-width:640px;margin:0 auto;border:1px solid #e5e7eb;">
      <div style="background:#f59e0b;color:white;padding:16px 20px;font-weight:700;font-size:18px;">⏰ Follow-up Reminder</div>
      <div style="padding:20px;">
        <p>${escapeHtml(lead?.full_name || 'A lead')} has been waiting and needs a follow-up.</p>
        <p><strong>Contact:</strong><br/>Name: ${escapeHtml(lead?.full_name || 'Not provided')}<br/>Phone: <a href="tel:${escapeHtml(lead?.phone || '')}">${escapeHtml(lead?.phone || 'Not provided')}</a><br/>Email: ${escapeHtml(lead?.email || 'Not provided')}</p>
        <p><strong>Lead details:</strong> ${escapeHtml(lead?.project_details || 'Not provided')}<br/><strong>Score:</strong> ${escapeHtml(String(lead?.lead_score || 'unknown').toUpperCase())}<br/><strong>Status:</strong> ${escapeHtml(lead?.status || 'unknown')}</p>
        ${lead?.follow_up_note ? `<p><strong>Your note:</strong> ${escapeHtml(lead.follow_up_note)}</p>` : ''}
        <p style="margin-top:20px;"><a href="${dashboardLink}" style="background:#6366f1;color:white;text-decoration:none;padding:10px 14px;border-radius:8px;font-weight:700;display:inline-block;">View Lead →</a></p>
      </div>
    </div>
  `;

  await resend.emails.send({
    from: 'ChatflowAI <reminders@chatflowai.com>',
    to: recipientEmail,
    subject: `⏰ Follow-up due: ${lead?.full_name || 'Lead'} — ${lead?.project_details?.substring(0, 50) || ''}`,
    html: htmlString,
  });
}

export async function sendMonthlyReport(business, stats) {
  if (!canSendEmail('sendMonthlyReport')) return { skipped: true, reason: 'RESEND_API_KEY missing' };
  const resend = getResendClient();
  if (!resend) return { skipped: true, reason: 'RESEND_API_KEY missing' };

  const month = new Date().toLocaleDateString('en-US', { month: 'long', year: 'numeric' });

  const htmlString = `
    <div style="font-family:Arial,sans-serif;line-height:1.5;color:#111827;max-width:680px;margin:0 auto;border:1px solid #e5e7eb;">
      <div style="background:#111827;color:white;padding:16px 20px;">
        <div style="font-weight:700;font-size:20px;">📊 Your ChatflowAI Report — ${escapeHtml(month)}</div>
        <div style="color:#d1d5db;">${escapeHtml(business?.business_name || 'Your Business')}</div>
      </div>
      <div style="padding:20px;">
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:14px;">
          <div style="border:1px solid #e5e7eb;border-radius:8px;padding:12px;"><strong>Total Leads:</strong> ${escapeHtml(stats?.total_leads ?? 0)}</div>
          <div style="border:1px solid #e5e7eb;border-radius:8px;padding:12px;"><strong>Hot Leads:</strong> ${escapeHtml(stats?.hot_leads ?? 0)} 🔥</div>
          <div style="border:1px solid #e5e7eb;border-radius:8px;padding:12px;"><strong>Jobs Won:</strong> ${escapeHtml(stats?.won_leads ?? 0)}</div>
          <div style="border:1px solid #e5e7eb;border-radius:8px;padding:12px;"><strong>Revenue:</strong> $${escapeHtml((stats?.revenue || 0).toLocaleString())}</div>
        </div>
        <div style="background:#dbeafe;color:#1e3a8a;padding:12px;border-radius:8px;">
          Your chatbot captured ${escapeHtml(stats?.after_hours_leads ?? 0)} leads while you were offline last month.
        </div>
      </div>
      <div style="padding:12px 20px;color:#6b7280;font-size:12px;border-top:1px solid #e5e7eb;">Powered by ChatflowAI</div>
    </div>
  `;

  await resend.emails.send({
    from: 'ChatflowAI <reports@chatflowai.com>',
    to: business?.owner_email,
    subject: `📊 Your ChatflowAI Monthly Report — ${month}`,
    html: htmlString,
  });
}
