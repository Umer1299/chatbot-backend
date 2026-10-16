import pool from '../db/pool.js';

export async function requireChatSession(req, res, next) {
  const { botId, sessionId, message } = req.body || {};
  if (typeof botId !== 'string' || typeof sessionId !== 'string' || !sessionId.trim() ||
      sessionId.length > 200 || typeof message !== 'string' || !message.trim()) {
    return res.status(400).json({ error: 'botId, sessionId and message are required strings' });
  }
  if (botId !== req.namespace) return res.status(403).json({ error: 'Invalid bot scope' });
  if (req.chatConfig && (req.chatConfig.is_disabled || req.chatSession)) return next();
  try {
    // One durable lookup for this request: cached config must never authorize a
    // disabled/inactive bot or one whose active configuration was removed.
    const { rows } = await pool.query(`SELECT bc.system_prompt, bc.selected_agents, bc.selected_model,
      bc.welcome_message, bc.starter_prompts, bc.is_draft, bc.detected_location, bc.detected_services,
      b.industry, b.business_name, b.owner_email, b.owner_phone, b.escalation_email, b.primary_color,
      b.calendly_link, b.availability_slots, b.bot_id, b.id as business_id, b.timezone, b.plan,
      b.is_disabled, b.disabled_reason
      FROM bot_configs bc JOIN businesses b ON bc.business_id = b.id
      WHERE b.bot_id=$1 AND b.active=true AND bc.active=true LIMIT 1`, [req.namespace]);
    if (!rows[0]) return res.status(404).json({ error: 'Bot not configured', message: 'Please complete onboarding first' });
    req.chatConfig = { ...rows[0], calendlyLink: rows[0].calendly_link, ownerPhone: rows[0].owner_phone };
    // The chat handler owns the compatible disabled JSON/SSE response. Stop
    // before session creation; the inquiry wrapper also skips this config.
    if (req.chatConfig.is_disabled) return next();
    const businessId = req.chatConfig.business_id;
    // The primary key arbitrates concurrent first requests. Never reassign an existing session.
    await pool.query(`INSERT INTO sessions (id,business_id,current_phase,collected_data,status,started_at,last_activity_at)
      VALUES ($1,$2,1,'{}','active',NOW(),NOW()) ON CONFLICT (id) DO NOTHING`, [sessionId, businessId]);
    const result = await pool.query('SELECT * FROM sessions WHERE id=$1 AND business_id=$2', [sessionId, businessId]);
    if (!result.rows[0]) return res.status(403).json({ error: 'Invalid session scope' });
    req.chatSession = result.rows[0];
    return next();
  } catch (error) { return next(error); }
}
