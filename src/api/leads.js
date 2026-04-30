import { Router } from 'express';
import pool from '../db/pool.js';
import { getKnowledgeAge } from '../db/vectorStore.js';
import requireAuth from '../middleware/jwtAuth.js';

const router = Router();

router.get('/', requireAuth, async (req, res) => {
  const page = parseInt(req.query.page || '1', 10);
  const limit = Math.min(parseInt(req.query.limit || '50', 10), 200);
  const offset = (page - 1) * limit;

  const allowedSortBy = new Set(['created_at', 'lead_score', 'status', 'estimated_value', 'actual_value']);
  const sortBy = allowedSortBy.has(req.query.sortBy) ? req.query.sortBy : 'created_at';
  const sortDir = req.query.sortDir === 'asc' ? 'ASC' : 'DESC';

  const where = ['l.business_id = $1'];
  const countWhere = ['business_id = $1'];
  const values = [req.business.businessId];

  const addFilter = (condition, countCondition, value) => {
    values.push(value);
    where.push(condition.replace('$N', `$${values.length}`));
    countWhere.push(countCondition.replace('$N', `$${values.length}`));
  };

  if (req.query.score) addFilter('l.lead_score = $N', 'lead_score = $N', req.query.score);
  if (req.query.status) addFilter('l.status = $N', 'status = $N', req.query.status);
  if (req.query.search) {
    addFilter('(l.full_name ILIKE $N OR l.phone ILIKE $N OR l.email ILIKE $N)', '(full_name ILIKE $N OR phone ILIKE $N OR email ILIKE $N)', `%${req.query.search}%`);
  }
  if (req.query.dateFrom) addFilter('l.created_at >= $N', 'created_at >= $N', req.query.dateFrom);
  if (req.query.dateTo) addFilter('l.created_at <= $N', 'created_at <= $N', req.query.dateTo);

  const listValues = [...values, limit, offset];

  const [listResult, countResult] = await Promise.all([
    pool.query(
      `SELECT l.*, ps.stage_label, ps.stage_color
       FROM leads l
       LEFT JOIN pipeline_stages ps
         ON ps.stage_key = l.status
         AND ps.industry = l.industry
         AND (ps.business_id = l.business_id OR ps.business_id IS NULL)
       WHERE ${where.join(' AND ')}
       ORDER BY l.${sortBy} ${sortDir}
       LIMIT $${values.length + 1} OFFSET $${values.length + 2}`,
      listValues,
    ),
    pool.query(`SELECT COUNT(*)::int AS total FROM leads WHERE ${countWhere.join(' AND ')}`, values),
  ]);

  const total = countResult.rows[0]?.total || 0;

  return res.json({ leads: listResult.rows, total, page, pages: Math.ceil(total / limit) });
});

router.get('/analytics/summary', requireAuth, async (req, res) => {
  const days = parseInt(req.query.days || '30', 10);
  const businessId = req.business.businessId;

  const [overviewResult, byDayResult, agentUsageResult, knowledgeAge] = await Promise.all([
    pool.query(`SELECT
      COUNT(*)::int AS total,
      COUNT(*) FILTER (WHERE lead_score='hot')::int AS hot,
      COUNT(*) FILTER (WHERE lead_score='warm')::int AS warm,
      COUNT(*) FILTER (WHERE lead_score='cold')::int AS cold,
      COUNT(*) FILTER (WHERE status='appointment_shown')::int AS appointments_shown,
      COUNT(*) FILTER (WHERE status='won')::int AS won,
      COALESCE(SUM(CASE WHEN status='won' THEN actual_value ELSE 0 END),0) AS revenue,
      COALESCE(SUM(estimated_value),0) AS pipeline_value,
      COUNT(*) FILTER (WHERE EXTRACT(HOUR FROM created_at) < 8 OR EXTRACT(HOUR FROM created_at) >= 18 OR EXTRACT(DOW FROM created_at) IN (0,6))::int AS after_hours
      FROM leads
      WHERE business_id=$1 AND created_at >= NOW() - ($2::text || ' days')::interval`, [businessId, days]),
    pool.query(`SELECT DATE(created_at) AS date,
      COUNT(*)::int AS total,
      COUNT(*) FILTER (WHERE lead_score='hot')::int AS hot
      FROM leads
      WHERE business_id=$1 AND created_at >= NOW() - ($2::text || ' days')::interval
      GROUP BY DATE(created_at)
      ORDER BY date ASC`, [businessId, days]),
    pool.query(`SELECT agent, COUNT(*)::int AS total
      FROM leads, UNNEST(COALESCE(agents_used, ARRAY[]::text[])) AS agent
      WHERE business_id=$1
      GROUP BY agent
      ORDER BY total DESC`, [businessId]),
    getKnowledgeAge(businessId),
  ]);

  return res.json({
    overview: overviewResult.rows[0] || {},
    byDay: byDayResult.rows,
    agentUsage: agentUsageResult.rows,
    knowledgeAge,
  });
});

router.get('/:leadId', requireAuth, async (req, res) => {
  const { leadId } = req.params;
  const businessId = req.business.businessId;

  const [leadResult, messagesResult, notificationsResult] = await Promise.all([
    pool.query(
      `SELECT l.*, ps.stage_label, ps.stage_color
       FROM leads l
       LEFT JOIN pipeline_stages ps
         ON ps.stage_key = l.status
         AND ps.industry = l.industry
         AND (ps.business_id = l.business_id OR ps.business_id IS NULL)
       WHERE l.id = $1 AND l.business_id = $2
       LIMIT 1`,
      [leadId, businessId],
    ),
    pool.query(
      `SELECT * FROM messages
       WHERE session_id = (
         SELECT id FROM sessions WHERE lead_id = $1 LIMIT 1
       )
       ORDER BY created_at ASC`,
      [leadId],
    ),
    pool.query(
      `SELECT * FROM notifications
       WHERE lead_id = $1
       ORDER BY sent_at DESC
       LIMIT 10`,
      [leadId],
    ),
  ]);

  if (!leadResult.rows[0]) return res.status(404).json({ error: 'Lead not found' });

  return res.json({
    lead: leadResult.rows[0],
    messages: messagesResult.rows,
    notifications: notificationsResult.rows,
  });
});

router.patch('/:leadId', requireAuth, async (req, res) => {
  const allowedFields = ['status', 'owner_notes', 'follow_up_date', 'follow_up_note', 'estimated_value', 'actual_value', 'tags', 'assigned_to'];
  const updates = [];
  const values = [req.params.leadId, req.business.businessId];

  for (const field of allowedFields) {
    if (Object.prototype.hasOwnProperty.call(req.body, field)) {
      values.push(req.body[field]);
      updates.push(`${field} = $${values.length}`);
    }
  }

  if (updates.length === 0) return res.status(400).json({ error: 'No valid fields provided' });

  updates.push('updated_at = NOW()');
  if (Object.prototype.hasOwnProperty.call(req.body, 'status')) {
    updates.push('status_updated_at = NOW()');
  }

  const query = `UPDATE leads SET ${updates.join(', ')} WHERE id = $1 AND business_id = $2 RETURNING *`;
  const result = await pool.query(query, values);
  if (!result.rows[0]) return res.status(404).json({ error: 'Lead not found' });

  return res.json({ lead: result.rows[0] });
});

export default router;
