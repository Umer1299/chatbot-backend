import { Router } from 'express';
import pool from '../db/pool.js';
import requireAuth from '../middleware/jwtAuth.js';
import { redisClient } from '../services/redis.js';

const router = Router();

function parsePositiveInt(value, fallback, max) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(parsed, max);
}

async function requireInquiryReadAuth(req, res, next) {
  const chatbotToken = req.headers['x-chatbot-token'];

  if (!chatbotToken) {
    return requireAuth(req, res, next);
  }

  const namespace = await redisClient.get(`chatbot_token:${chatbotToken}`);
  if (!namespace) {
    return res.status(403).json({ error: 'Invalid or expired token' });
  }

  const businessResult = await pool.query('SELECT id FROM businesses WHERE bot_id=$1 LIMIT 1', [namespace]);
  const business = businessResult.rows[0];

  if (!business) {
    return res.status(404).json({ error: 'Bot not configured' });
  }

  req.chatbotToken = chatbotToken;
  req.namespace = namespace;
  req.business = { ...(req.business || {}), businessId: business.id };

  return next();
}

router.get('/', requireInquiryReadAuth, async (req, res) => {
  const page = parsePositiveInt(req.query.page || '1', 1, 100000);
  const limit = parsePositiveInt(req.query.limit || '50', 50, 200);
  const offset = (page - 1) * limit;
  const allowedSortBy = new Set(['created_at', 'updated_at', 'status', 'priority', 'inquiry_type']);
  const sortBy = allowedSortBy.has(req.query.sortBy) ? req.query.sortBy : 'created_at';
  const sortDir = req.query.sortDir === 'asc' ? 'ASC' : 'DESC';
  const where = ['business_id = $1'];
  const values = [req.business.businessId];

  const addFilter = (condition, value) => {
    values.push(value);
    where.push(condition.replace('$N', `$${values.length}`));
  };

  if (req.query.status) addFilter('status = $N', req.query.status);
  if (req.query.type) addFilter('inquiry_type = $N', req.query.type);
  if (req.query.priority) addFilter('priority = $N', req.query.priority);
  if (req.query.search) {
    addFilter('(full_name ILIKE $N OR phone ILIKE $N OR email ILIKE $N OR company_name ILIKE $N OR contact_reason ILIKE $N OR message_summary ILIKE $N)', `%${req.query.search}%`);
  }
  if (req.query.dateFrom) addFilter('created_at >= $N', req.query.dateFrom);
  if (req.query.dateTo) addFilter('created_at <= $N', req.query.dateTo);

  const listValues = [...values, limit, offset];
  const [listResult, countResult] = await Promise.all([
    pool.query(`SELECT * FROM inquiries WHERE ${where.join(' AND ')} ORDER BY ${sortBy} ${sortDir} LIMIT $${values.length + 1} OFFSET $${values.length + 2}`, listValues),
    pool.query(`SELECT COUNT(*)::int AS total FROM inquiries WHERE ${where.join(' AND ')}`, values),
  ]);

  const total = countResult.rows[0]?.total || 0;
  return res.json({ inquiries: listResult.rows, total, page, pages: Math.ceil(total / limit) });
});

router.get('/analytics/summary', requireInquiryReadAuth, async (req, res) => {
  const days = parsePositiveInt(req.query.days || '30', 30, 365);
  const businessId = req.business.businessId;
  const [overviewResult, byTypeResult, byDayResult, recentResult] = await Promise.all([
    pool.query(`SELECT COUNT(*)::int AS total, COUNT(*) FILTER (WHERE status='new')::int AS new, COUNT(*) FILTER (WHERE status='open')::int AS open, COUNT(*) FILTER (WHERE status='resolved')::int AS resolved, COUNT(*) FILTER (WHERE priority='high')::int AS high_priority, COUNT(*) FILTER (WHERE urgency_flag IS TRUE)::int AS urgent FROM inquiries WHERE business_id=$1 AND created_at >= NOW() - ($2::text || ' days')::interval`, [businessId, days]),
    pool.query(`SELECT inquiry_type, COUNT(*)::int AS total FROM inquiries WHERE business_id=$1 AND created_at >= NOW() - ($2::text || ' days')::interval GROUP BY inquiry_type ORDER BY total DESC`, [businessId, days]),
    pool.query(`SELECT DATE(created_at) AS date, COUNT(*)::int AS total FROM inquiries WHERE business_id=$1 AND created_at >= NOW() - ($2::text || ' days')::interval GROUP BY DATE(created_at) ORDER BY date ASC`, [businessId, days]),
    pool.query(`SELECT id, inquiry_type, status, priority, full_name, email, phone, message_summary, created_at FROM inquiries WHERE business_id=$1 ORDER BY created_at DESC LIMIT 10`, [businessId]),
  ]);

  return res.json({
    overview: overviewResult.rows[0] || {},
    byType: byTypeResult.rows,
    byDay: byDayResult.rows,
    recentInquiries: recentResult.rows,
  });
});

router.get('/:inquiryId', requireInquiryReadAuth, async (req, res) => {
  const { inquiryId } = req.params;
  const businessId = req.business.businessId;
  const inquiryResult = await pool.query('SELECT * FROM inquiries WHERE id=$1 AND business_id=$2 LIMIT 1', [inquiryId, businessId]);
  const inquiry = inquiryResult.rows[0];
  if (!inquiry) return res.status(404).json({ error: 'Inquiry not found' });

  const messagesResult = inquiry.session_id
    ? await pool.query('SELECT * FROM messages WHERE session_id=$1 ORDER BY created_at ASC', [inquiry.session_id])
    : { rows: [] };

  return res.json({ inquiry, messages: messagesResult.rows });
});

router.patch('/:inquiryId', requireAuth, async (req, res) => {
  const allowedFields = ['status', 'priority', 'owner_notes', 'assigned_to'];
  const updates = [];
  const values = [req.params.inquiryId, req.business.businessId];

  for (const field of allowedFields) {
    if (Object.prototype.hasOwnProperty.call(req.body, field)) {
      values.push(req.body[field]);
      updates.push(`${field} = $${values.length}`);
    }
  }

  if (updates.length === 0) return res.status(400).json({ error: 'No valid fields provided' });
  updates.push('updated_at = NOW()');

  const result = await pool.query(`UPDATE inquiries SET ${updates.join(', ')} WHERE id=$1 AND business_id=$2 RETURNING *`, values);
  if (!result.rows[0]) return res.status(404).json({ error: 'Inquiry not found' });
  return res.json({ inquiry: result.rows[0] });
});

export default router;