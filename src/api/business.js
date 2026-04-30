import { Router } from 'express';
import pool from '../db/pool.js';
import requireAuth from '../middleware/jwtAuth.js';
import { redisClient } from '../services/redis.js';
import { suggestAgents } from '../agents/agentSelector.js';
import { AGENT_TEMPLATES } from '../agents/templates.js';

const router = Router();

router.get('/settings', requireAuth, async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM businesses WHERE id = $1', [req.business.businessId]);
  return res.json({ business: rows[0] || null });
});

router.patch('/settings', requireAuth, async (req, res) => {
  const allowed = ['business_name', 'primary_color', 'escalation_email', 'owner_phone', 'availability_slots', 'booking_type', 'calendly_link', 'timezone'];
  const updates = [];
  const values = [req.business.businessId];

  for (const field of allowed) {
    if (Object.prototype.hasOwnProperty.call(req.body, field)) {
      values.push(req.body[field]);
      updates.push(`${field} = $${values.length}`);
    }
  }

  updates.push('updated_at = NOW()');
  const result = await pool.query(
    `UPDATE businesses SET ${updates.join(', ')} WHERE id = $1 RETURNING *`,
    values,
  );

  const business = result.rows[0];
  if (business?.bot_id && redisClient) {
    await redisClient.del(`chatbot_config:${business.bot_id}`);
  }

  return res.json({ business });
});

router.get('/bot-config', requireAuth, async (req, res) => {
  const { rows } = await pool.query(
    `SELECT bc.*, b.calendly_link, b.availability_slots, b.bot_id, b.primary_color, b.welcome_message, b.industry
     FROM bot_configs bc
     JOIN businesses b ON bc.business_id = b.id
     WHERE bc.business_id = $1 AND bc.active = true
     LIMIT 1`,
    [req.business.businessId],
  );

  const row = rows[0] || null;
  const industry = row?.industry || req.business.industry;
  const availableAgents = AGENT_TEMPLATES[industry]?.agents || {};

  return res.json({
    config: row,
    availableAgents,
    suggestedAgentIds: row?.selected_agents || suggestAgents(industry, {}, '').suggestedAgentIds || [],
  });
});

router.post('/bot-config/approve', requireAuth, async (req, res) => {
  const { systemPrompt, welcomeMessage, starterPrompts, selectedAgents } = req.body;
  const businessId = req.business.businessId;

  await pool.query(
    `UPDATE bot_configs
     SET system_prompt = $1,
         welcome_message = $2,
         starter_prompts = $3,
         selected_agents = $4,
         is_draft = false,
         active = true,
         updated_at = NOW()
     WHERE business_id = $5`,
    [systemPrompt, welcomeMessage, starterPrompts, selectedAgents, businessId],
  );

  await pool.query(
    `UPDATE businesses
     SET onboarding_complete = true,
         updated_at = NOW()
     WHERE id = $1`,
    [businessId],
  );

  const botResult = await pool.query('SELECT bot_id FROM businesses WHERE id = $1', [businessId]);
  const botId = botResult.rows[0]?.bot_id;
  if (botId && redisClient) await redisClient.del(`chatbot_config:${botId}`);

  return res.json({ success: true, message: 'Chatbot is now live' });
});

router.get('/bot-config/:botId/preview', async (req, res) => {
  const { rows } = await pool.query(
    `SELECT bc.*, b.calendly_link, b.availability_slots, b.bot_id, b.primary_color, b.welcome_message, b.industry
     FROM bot_configs bc
     JOIN businesses b ON bc.business_id = b.id
     WHERE b.bot_id = $1 AND bc.active = true
     LIMIT 1`,
    [req.params.botId],
  );

  if (!rows[0]) return res.status(404).json({ error: 'Bot config not found' });

  return res.json({ config: rows[0], isPreview: true });
});

export default router;
