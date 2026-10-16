import pool from '../db/pool.js';

export async function requireChatSession(req, res, next) {
  const { botId, sessionId, message } = req.body || {};
  if (typeof botId !== 'string' || typeof sessionId !== 'string' || !sessionId.trim() ||
      sessionId.length > 200 || typeof message !== 'string' || !message.trim()) {
    return res.status(400).json({ error: 'botId, sessionId and message are required strings' });
  }
  if (botId !== req.namespace) return res.status(403).json({ error: 'Invalid bot scope' });
  if (req.chatSession) return next();
  try {
    const { rows } = await pool.query('SELECT id FROM businesses WHERE bot_id=$1 AND active=true', [req.namespace]);
    if (!rows[0]) return res.status(404).json({ error: 'Bot not configured' });
    const businessId = rows[0].id;
    // The primary key arbitrates concurrent first requests. Never reassign an existing session.
    await pool.query(`INSERT INTO sessions (id,business_id,current_phase,collected_data,status,started_at,last_activity_at)
      VALUES ($1,$2,1,'{}','active',NOW(),NOW()) ON CONFLICT (id) DO NOTHING`, [sessionId, businessId]);
    const result = await pool.query('SELECT * FROM sessions WHERE id=$1 AND business_id=$2', [sessionId, businessId]);
    if (!result.rows[0]) return res.status(403).json({ error: 'Invalid session scope' });
    req.chatSession = result.rows[0];
    return next();
  } catch (error) { return next(error); }
}
