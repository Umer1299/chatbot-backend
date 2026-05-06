import cron from 'node-cron';
import pool from '../db/pool.js';
import { sendFollowUpReminder, sendMonthlyReport } from '../services/emailService.js';
import { generateWeeklyReport } from '../services/reportService.js';
import { redisClient } from '../services/redis.js';

async function withDistributedLock(lockKey, ttlSeconds, fn) {
  const lockValue = 'lock:' + Date.now() + ':' + Math.random().toString(36).slice(2);

  const acquired = await redisClient.set(
    'cron_lock:' + lockKey,
    lockValue,
    'NX', 'EX', ttlSeconds,
  );

  if (!acquired) {
    console.log('[cron] Skipping ' + lockKey + ' — already running on another instance');
    return;
  }

  try {
    await fn();
  } finally {
    const current = await redisClient.get('cron_lock:' + lockKey);
    if (current === lockValue) {
      await redisClient.del('cron_lock:' + lockKey);
    }
  }
}

export function startReminderJobs() {
  console.log('Reminder cron jobs started');

  cron.schedule('0 * * * *', () =>
    withDistributedLock('hot-lead-reminder', 3500, async () => {
    try {
      const { rows: leads } = await pool.query(
        `SELECT l.*, b.escalation_email, b.owner_email, b.business_name
         FROM leads l
         JOIN businesses b ON l.business_id = b.id
         WHERE l.lead_score = 'hot'
           AND l.status = 'new'
           AND l.created_at < NOW() - INTERVAL '2 hours'
           AND l.hot_lead_reminder_sent = false
           AND b.active = true`,
      );

      for (const lead of leads) {
        const recipientEmail = lead.escalation_email || lead.owner_email;
        await sendFollowUpReminder(lead, recipientEmail);

        await pool.query(
          `UPDATE leads
           SET hot_lead_reminder_sent = true,
               updated_at = NOW()
           WHERE id = $1`,
          [lead.id],
        );

        console.log(`Hot lead reminder sent for lead ${lead.id}`);
      }
    } catch (error) {
      console.error('HOT_LEAD_REMINDER_ERROR:', error);
    }
    })
  );

  cron.schedule('0 9 * * *', () =>
    withDistributedLock('followup-reminder', 86000, async () => {
    try {
      const { rows: leads } = await pool.query(
        `SELECT l.*, b.escalation_email, b.owner_email, b.business_name
         FROM leads l
         JOIN businesses b ON l.business_id = b.id
         WHERE l.follow_up_date = CURRENT_DATE
           AND l.follow_up_reminder_sent = false
           AND b.active = true`,
      );

      for (const lead of leads) {
        const recipientEmail = lead.escalation_email || lead.owner_email;
        await sendFollowUpReminder(lead, recipientEmail);

        await pool.query(
          `UPDATE leads
           SET follow_up_reminder_sent = true,
               updated_at = NOW()
           WHERE id = $1`,
          [lead.id],
        );
      }
    } catch (error) {
      console.error('FOLLOWUP_REMINDER_ERROR:', error);
    }
    })
  );

  cron.schedule('*/30 * * * *', () =>
    withDistributedLock('inactive-session-check', 1700, async () => {
    try {
      const { rows: sessions } = await pool.query(
        `SELECT s.*, b.id as business_id, b.escalation_email, b.owner_email, b.business_name, b.industry
         FROM sessions s
         JOIN businesses b ON s.business_id = b.id
         WHERE s.status = 'active'
           AND s.last_activity_at < NOW() - INTERVAL '30 minutes'
           AND s.lead_captured = false
           AND (
             s.collected_data->>'contact_name' IS NOT NULL
             OR s.collected_data->>'phone' IS NOT NULL
             OR s.collected_data->>'contact_phone' IS NOT NULL
           )`,
      );

      for (const session of sessions) {
        await pool.query(
          `UPDATE sessions
           SET status = 'abandoned',
               completed_at = NOW()
           WHERE id = $1`,
          [session.id],
        );

        const partialData = session.collected_data || {};
        if (partialData.contact_name || partialData.phone || partialData.contact_phone || partialData.contact_email || partialData.email) {
          await pool.query(
            `INSERT INTO leads
              (business_id, session_id, full_name, phone, email,
               lead_score, industry, industry_data, ai_summary,
               project_details, status, source)
             VALUES ($1, $2, $3, $4, $5, 'cold', $6, $7, $8, $9, 'new', 'abandoned_session')
             ON CONFLICT DO NOTHING`,
            [
              session.business_id,
              session.id,
              partialData.contact_name || null,
              partialData.contact_phone || partialData.phone || null,
              partialData.contact_email || partialData.email || null,
              session.industry || null,
              JSON.stringify(partialData),
              'Partial lead - visitor left mid-conversation',
              'Incomplete inquiry',
            ],
          );

          console.log('Recovered partial lead from abandoned session');
        }
      }
    } catch (error) {
      console.error('ABANDONMENT_RECOVERY_ERROR:', error);
    }
    })
  );


  // Weekly report every Monday at 8 AM
  cron.schedule('0 8 * * 1', () =>
    withDistributedLock('weekly-report', 86000, async () => {
      try {
        const { rows: businesses } = await pool.query(
          'SELECT id, owner_email, business_name FROM businesses WHERE active = true'
        );
        for (const biz of businesses) {
          try {
            const report = await generateWeeklyReport(biz.id);
            console.log(`Weekly report generated for ${biz.business_name} (id: ${biz.id})`);
            // TODO: send email if email service supports generic send
          } catch (err) {
            console.error(`Report generation failed for ${biz.business_name}:`, err.message);
          }
        }
      } catch (error) {
        console.error('WEEKLY_REPORT_CRON_ERROR:', error);
      }
    })
  );

  cron.schedule('0 8 1 * *', async () => {
    try {
      const { rows: businesses } = await pool.query(
        `SELECT *
         FROM businesses
         WHERE active = true
           AND plan != 'trial'`,
      );

      for (const business of businesses) {
        const { rows } = await pool.query(
          `SELECT
             COUNT(*) as total_leads,
             COUNT(CASE WHEN lead_score = 'hot' THEN 1 END) as hot_leads,
             COUNT(CASE WHEN status = 'won' THEN 1 END) as won_leads,
             SUM(CASE WHEN status = 'won' THEN actual_value ELSE 0 END) as revenue,
             COUNT(CASE
               WHEN EXTRACT(HOUR FROM created_at) < 8
                 OR EXTRACT(HOUR FROM created_at) >= 18
                 OR EXTRACT(DOW FROM created_at) IN (0, 6)
               THEN 1 END) as after_hours_leads
           FROM leads
           WHERE business_id = $1
             AND created_at > NOW() - INTERVAL '30 days'`,
          [business.id],
        );

        await sendMonthlyReport(business, rows[0]);
        console.log(`Monthly report sent to ${business.owner_email}`);
      }
    } catch (error) {
      console.error('MONTHLY_REPORT_ERROR:', error);
    }
  });
}
