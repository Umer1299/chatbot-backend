import { Router } from 'express';
import pool from '../db/pool.js';
import requireAuth from '../middleware/jwtAuth.js';
import { redisClient } from '../services/redis.js';
import { suggestAgents } from '../agents/agentSelector.js';
import { AGENT_TEMPLATES } from '../agents/templates.js';
import { getAvailableModels, getLockedModels, validateModelAccess } from '../services/modelService.js';

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


router.get('/models', requireAuth, async (req, res) => {
  try {
    const plan = req.business.plan || 'trial';
    const businessId = req.business.businessId;

    const [available, locked, configResult] = await Promise.all([
      getAvailableModels(plan),
      getLockedModels(plan),
      pool.query(
        `SELECT selected_model
         FROM bot_configs
         WHERE business_id = $1 AND active = true
         LIMIT 1`,
        [businessId]
      )
    ]);

    res.json({
      currentPlan: plan,
      currentModel: configResult.rows[0]?.selected_model || 'gpt-4o-mini',
      availableModels: available,
      lockedModels: locked
    });
  } catch (err) {
    console.error('[business/models]', err.message);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});


router.patch('/model', requireAuth, async (req, res) => {
  try {
    const { modelId } = req.body;
    const plan = req.business.plan || 'trial';
    const businessId = req.business.businessId;

    if (!modelId) {
      return res.status(400).json({ error: 'modelId required' });
    }

    // Verify model exists in database
    const modelRow = await pool.query(
      `SELECT model_id, branded_name
       FROM model_configs
       WHERE model_id = $1 AND is_active = true`,
      [modelId]
    );
    if (!modelRow.rows.length) {
      return res.status(400).json({ error: 'Invalid model ID: ' + modelId });
    }

    // Check plan allows this model
    const validation = await validateModelAccess(modelId, plan);
    if (!validation.allowed) {
      console.warn('[business/model] Access denied', {
        businessId, modelId, plan, ip: req.ip
      });
      return res.status(403).json({
        error: validation.reason,
        currentPlan: plan,
        requiredPlan: validation.requiredPlan,
        availableFallback: validation.fallback
      });
    }

    // Update both tables
    await Promise.all([
      pool.query(
        `UPDATE bot_configs
         SET selected_model = $1, updated_at = NOW()
         WHERE business_id = $2 AND active = true`,
        [modelId, businessId]
      ),
      pool.query(
        `UPDATE businesses
         SET selected_model = $1, updated_at = NOW()
         WHERE id = $2`,
        [modelId, businessId]
      )
    ]);

    // Clear Redis bot config cache
    const bizRow = await pool.query(
      'SELECT bot_id FROM businesses WHERE id = $1',
      [businessId]
    );
    if (bizRow.rows[0]?.bot_id) {
      await redisClient.del('chatbot_config:' + bizRow.rows[0].bot_id);
    }

    res.json({
      success: true,
      selectedModel: modelId,
      brandedName: modelRow.rows[0].branded_name,
      message: 'Chatbot now uses ' + modelRow.rows[0].branded_name
    });
  } catch (err) {
    console.error('[business/model]', err.message);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});


router.post('/disable', requireAuth, async (req, res) => {
  try {
    const businessId = req.business.businessId;
    const { reason, disabledBy } = req.body;

    const source = ['bubble', 'admin'].includes(disabledBy) ? disabledBy : 'bubble';

    await pool.query(`
      UPDATE businesses SET
        is_disabled     = true,
        disabled_reason = $1,
        disabled_at     = NOW(),
        disabled_by     = $2,
        updated_at      = NOW()
      WHERE id = $3
    `, [reason || 'Disabled by administrator', source, businessId]);

    // Clear Redis cache immediately
    const bizRow = await pool.query(
      'SELECT bot_id FROM businesses WHERE id = $1',
      [businessId]
    );
    if (bizRow.rows[0]?.bot_id) {
      await redisClient.del('chatbot_config:' + bizRow.rows[0].bot_id);
    }

    console.log('[business/disable]', { businessId, reason, source, ip: req.ip });

    res.json({
      success: true,
      message: 'Chatbot disabled',
      disabledAt: new Date().toISOString()
    });
  } catch (err) {
    console.error('[business/disable]', err.message);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

router.post('/enable', requireAuth, async (req, res) => {
  try {
    const businessId = req.business.businessId;

    await pool.query(`
      UPDATE businesses SET
        is_disabled     = false,
        disabled_reason = NULL,
        disabled_at     = NULL,
        disabled_by     = NULL,
        updated_at      = NOW()
      WHERE id = $1
    `, [businessId]);

    const bizRow = await pool.query(
      'SELECT bot_id FROM businesses WHERE id = $1',
      [businessId]
    );
    if (bizRow.rows[0]?.bot_id) {
      await redisClient.del('chatbot_config:' + bizRow.rows[0].bot_id);
    }

    console.log('[business/enable]', { businessId, ip: req.ip });

    res.json({
      success: true,
      message: 'Chatbot re-enabled'
    });
  } catch (err) {
    console.error('[business/enable]', err.message);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

router.get('/status', requireAuth, async (req, res) => {
  try {
    const businessId = req.business.businessId;

    const result = await pool.query(`
      SELECT is_disabled, disabled_reason,
             disabled_at, disabled_by,
             plan, selected_model
      FROM businesses WHERE id = $1
    `, [businessId]);

    if (!result.rows.length) {
      return res.status(404).json({ error: 'Business not found' });
    }

    const biz = result.rows[0];
    res.json({
      isDisabled:     biz.is_disabled || false,
      disabledReason: biz.disabled_reason || null,
      disabledAt:     biz.disabled_at || null,
      disabledBy:     biz.disabled_by || null,
      plan:           biz.plan,
      selectedModel:  biz.selected_model || 'gpt-4o-mini'
    });
  } catch (err) {
    console.error('[business/status]', err.message);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
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
    `SELECT b.bot_id, b.business_name, b.industry, b.primary_color,
            bc.welcome_message, bc.starter_prompts,
            bc.is_disabled, bc.disabled_reason
     FROM bot_configs bc
     JOIN businesses b ON bc.business_id = b.id
     WHERE b.bot_id = $1 AND bc.active = true
     LIMIT 1`,
    [req.params.botId],
  );

  if (!rows[0]) return res.status(404).json({ error: 'Bot config not found' });

  return res.json({
    botId: rows[0].bot_id,
    businessName: rows[0].business_name,
    industry: rows[0].industry,
    primaryColor: rows[0].primary_color,
    welcomeMessage: rows[0].welcome_message,
    starterPrompts: rows[0].starter_prompts || [],
    isPreview: true,
    isDisabled: rows[0].is_disabled || false,
    disabledMessage: rows[0].disabled_reason || null
  });
});

export default router;
