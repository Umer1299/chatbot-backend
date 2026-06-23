import cron from 'node-cron';
import pool from '../db/pool.js';
import { sendFollowUpReminder, sendMonthlyReport } from '../services/emailService.js';
import { redisClient } from '../services/redis.js';

async function lock(name, ttl, fn) {
  const value = 'lock:' + Date.now() + ':' + Math.random().toString(36).slice(2);
  const ok = await redisClient.set('cron_lock:' + name, value, 'NX', 'EX', ttl);
  if (!ok) return;
  try { await fn(); }
  finally {
    const current = await redisClient.get('cron_lock:' + name);
    if (current === value) await redisClient.del('cron_lock:' + name);
  }
}

const paidOnly = "b.plan NOT IN ('free', 'trial')";

export function startReminderJobs() {
  console.log('Reminder cron jobs started');

  cron.schedule('0 * * * *', () => lock('hot-lead-reminder', 3500, async () => {
    const { rows } = await pool.query(`
      SELECT l.*, b.escalation_email, b.owner_email, b.business_name
      FROM leads l
      JOIN businesses b ON l.business_id = b.id
      WHERE l.lead_score = 'hot'
        AND l.status = 'new'
        AND l.created_at < NOW() - INTERVAL '2 hours'
        AND l.hot_lead_reminder_sent = false
        AND ${paidOnly}
        AND b.active = true
    `);

    for (const lead of rows) {
      await sendFollowUpReminder(lead, lead.escalation_email || lead.owner_email);
      await pool.query('UPDATE leads SET hot_lead_reminder_sent = true, updated_at = NOW() WHERE id = $1', [lead.id]);
    }
  }));

  cron.schedule('0 9 * * *', () => lock('followup-reminder', 86000, async () => {
    const { rows } = await pool.query(`
      SELECT l.*, b.escalation_email, b.owner_email, b.business_name
      FROM leads l
      JOIN businesses b ON l.business_id = b.id
      WHERE l.follow_up_date = CURRENT_DATE
        AND l.follow_up_reminder_sent = false
        AND ${paidOnly}
        AND b.active = true
    `);

    for (const lead of rows) {
      await sendFollowUpReminder(lead, lead.escalation_email || lead.owner_email);
      await pool.query('UPDATE leads SET follow_up_reminder_sent = true, updated_at = NOW() WHERE id = $1', [lead.id]);
    }
  }));

  cron.schedule('0 8 1 * *', async () => {
    const { rows: businesses } = await pool.query(`SELECT * FROM businesses b WHERE b.active = true AND ${paidOnly}`);
    for (const business of businesses) {
      const { rows } = await pool.query(`
        SELECT
          COUNT(*) as total_leads,
          COUNT(CASE WHEN lead_score = 'hot' THEN 1 END) as hot_leads,
          COUNT(CASE WHEN status = 'won' THEN 1 END) as won_leads,
          SUM(CASE WHEN status = 'won' THEN actual_value ELSE 0 END) as revenue,
          COUNT(CASE WHEN EXTRACT(HOUR FROM created_at) < 8 OR EXTRACT(HOUR FROM created_at) >= 18 OR EXTRACT(DOW FROM created_at) IN (0, 6) THEN 1 END) as after_hours_leads
        FROM leads
        WHERE business_id = $1
          AND created_at > NOW() - INTERVAL '30 days'
      `, [business.id]);
      await sendMonthlyReport(business, rows[0]);
    }
  });
}
