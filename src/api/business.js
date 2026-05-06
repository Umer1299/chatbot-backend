import { Router } from 'express';
import pool from '../db/pool.js';
import requireAuth from '../middleware/jwtAuth.js';
import { redisClient } from '../services/redis.js';
import { suggestAgents } from '../agents/agentSelector.js';
import { AGENT_TEMPLATES } from '../agents/templates.js';
import { getAvailableModels, getLockedModels } from '../services/modelService.js';
import { buildMasterPrompt, buildAgentPromptInstructions } from '../agents/promptBuilder.js';

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

    // Check if model exists in database
    const modelResult = await pool.query(
      `SELECT model_id, branded_name, is_active, min_plan
       FROM model_configs
       WHERE model_id = $1`,
      [modelId]
    );

    if (!modelResult.rows.length) {
      return res.status(400).json({ error: 'Invalid model ID: ' + modelId });
    }

    const model = modelResult.rows[0];

    // If model is inactive, deny with 403
    if (!model.is_active) {
      console.warn('[business/model] Inactive model requested', {
        businessId, modelId, ip: req.ip
      });
      return res.status(403).json({
        error: model.branded_name + ' is not currently available.',
        currentPlan: plan,
        requiredPlan: model.min_plan
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
      brandedName: model.branded_name,
      message: 'Chatbot now uses ' + model.branded_name
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
  const scrapeResult = row?.result || {};
  const fallbackSuggestion = suggestAgents(industry, scrapeResult, '');
  const suggestedAgentIds = row?.selected_agents || fallbackSuggestion?.suggestedAgentIds || [];

  return res.json({
    business_name: scrapeResult.businessName || req.business.businessName || row?.business_name || 'Your Business',
    industry,
    business_summary: scrapeResult.businessSummary || null,
    services_products: scrapeResult.services || row?.detected_services || [],
    target_customers: scrapeResult.targetCustomers || [],
    business_tone: scrapeResult.businessTone || 'professional and helpful',
    suggested_chatbot_purpose: scrapeResult.suggestedChatbotPurpose || null,
    website_gaps: scrapeResult.websiteGaps || row?.missing_fields || [],
    contact_info: scrapeResult.contactInfo || {},
    system_prompt_draft: row?.system_prompt || scrapeResult.systemPromptDraft || '',
    welcome_message: row?.welcome_message || scrapeResult.welcomeMessage || '',
    starter_prompts: row?.starter_prompts || scrapeResult.starterPrompts || [],
    brand: {
      logo_url: scrapeResult?.brand?.logo_url || null,
      primary_color: scrapeResult?.brand?.primary_color || row?.primary_color || '#1F6FEB',
    },
    suggested_agents: suggestedAgentIds,
    availableAgents,
    config: row,
  });
});

router.post('/bot-config/approve', requireAuth, async (req, res) => {
  const { welcomeMessage, starterPrompts, selectedAgents } = req.body;
  const businessId = req.business.businessId;
  const selectedAgentIds = Array.isArray(selectedAgents) ? selectedAgents : [];
  const businessResult = await pool.query(
    `SELECT business_name, industry, owner_phone, calendly_link, availability_slots
     FROM businesses WHERE id = $1 LIMIT 1`,
    [businessId],
  );
  const b = businessResult.rows[0] || {};
  const { rows: configRows } = await pool.query(
    `SELECT detected_services, detected_location FROM bot_configs WHERE business_id = $1 LIMIT 1`,
    [businessId],
  );
  const c = configRows[0] || {};
  const { prompt: agentRoles } = buildAgentPromptInstructions(b.industry, selectedAgentIds);
  const { prompt: basePrompt } = buildMasterPrompt({
    industry: b.industry,
    businessName: b.business_name,
    primaryServices: c.detected_services || [],
    location: c.detected_location || '',
    ownerPhone: b.owner_phone,
    calendlyLink: b.calendly_link,
  }, selectedAgentIds, b.availability_slots || {});
  const masterSystemPrompt = `${basePrompt}

LEAD FIELDS TO COLLECT: name, phone, email, service needed, timeline, budget range, decision-maker status.
OBJECTION HANDLING: acknowledge concern, provide concise reassurance, offer practical next step.
BOOKING/QUOTE: gather required fields before quote/booking; then offer two time options or share Calendly when available.
FALLBACK RULES: if info missing, ask one clarifying question; if still unknown, be transparent and offer human follow-up.
TONE/STYLE: match business tone, stay concise, conversion-focused, and helpful.
RAG INSTRUCTIONS: prioritize retrieved website knowledge; do not fabricate pricing or policies not in context.
AGENT ROLE DEFINITIONS:
${agentRoles}`.trim();

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
        [masterSystemPrompt, welcomeMessage, starterPrompts, selectedAgentIds, businessId],
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

  return res.json({ success: true, message: 'Chatbot is now live', selected_agents: selectedAgentIds, system_prompt: masterSystemPrompt });
});

router.get('/bot-config/:botId/preview', async (req, res) => {
  const { rows } = await pool.query(
    `SELECT b.bot_id, b.business_name, b.industry, b.primary_color,
            bc.welcome_message, bc.starter_prompts,
            b.is_disabled, b.disabled_reason
     FROM bot_configs bc
     JOIN businesses b ON bc.business_id = b.id
     WHERE b.bot_id = $1
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
