import { Router } from 'express';
import pool from '../db/pool.js';
import requireAuth from '../middleware/jwtAuth.js';
import businessRoutes from './business.js';
import { sendLeadAlert } from '../services/emailService.js';
import { canReceiveLeadEmails, getPlanDefinition, normalizePlan } from '../services/planService.js';

const router = Router();

function publicBusinessPayload(business) {
  if (!business) return null;
  const publicPlan = normalizePlan(business.plan);
  return {
    ...business,
    stored_plan: business.plan,
    plan: publicPlan,
    planDetails: getPlanDefinition(publicPlan),
  };
}

router.get('/settings', requireAuth, async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM businesses WHERE id = $1', [req.business.businessId]);
  return res.json({ business: publicBusinessPayload(rows[0] || null) });
});

router.post('/test-lead-email', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM businesses WHERE id = $1', [req.business.businessId]);
    const business = rows[0];
    if (!business) return res.status(404).json({ error: 'Business not found' });

    const publicPlan = normalizePlan(business.plan);
    const recipient = business.escalation_email || business.owner_email;

    if (!canReceiveLeadEmails(publicPlan)) {
      return res.status(403).json({
        error: 'Lead email alerts are disabled for this plan',
        plan: publicPlan,
        storedPlan: business.plan,
      });
    }

    if (!recipient) {
      return res.status(400).json({ error: 'No escalation_email or owner_email is set for this business' });
    }

    const testLead = {
      id: 'test-lead-email',
      full_name: req.body?.full_name || 'James Carter',
      phone: req.body?.phone || '07123 456789',
      email: req.body?.email || 'james.carter@example.com',
      lead_score: 'hot',
      budget_range: req.body?.budget_range || '£18,000–£25,000',
      project_details: req.body?.project_details || 'Test Mobius office refurbishment lead email',
      ai_summary: 'This is a test lead email from ChatflowAI to confirm Resend and escalation email delivery.',
      score_reasons: ['Test email', 'Pro plan email alerts enabled'],
    };

    await sendLeadAlert(business, testLead);

    return res.json({
      success: true,
      message: 'Test lead email sent',
      to: recipient,
      plan: publicPlan,
      storedPlan: business.plan,
    });
  } catch (error) {
    console.error('[business/test-lead-email]', error.message);
    return res.status(500).json({
      error: 'Failed to send test lead email',
      message: error.message,
    });
  }
});

router.use(businessRoutes);

export default router;
