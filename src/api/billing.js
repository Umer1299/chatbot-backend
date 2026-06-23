import { Router } from 'express';
import pool from '../db/pool.js';
import requireAuth from '../middleware/jwtAuth.js';
import { redisClient } from '../services/redis.js';
import {
  assertSelectablePlan,
  canReceiveLeadEmails,
  getMonthlyLeadLimit,
  getPlanDefinition,
  listSelectablePlans,
  normalizePlan,
} from '../services/planService.js';

const router = Router();

async function getBillingSnapshot(businessId) {
  const businessResult = await pool.query(
    `SELECT id, plan, bot_id FROM businesses WHERE id = $1 LIMIT 1`,
    [businessId],
  );
  const business = businessResult.rows[0];
  if (!business) return null;

  const plan = normalizePlan(business.plan);
  const monthlyLeadLimit = getMonthlyLeadLimit(plan);
  const leadCountResult = await pool.query(
    `SELECT COUNT(*)::int AS leads_this_month
     FROM leads
     WHERE business_id = $1
       AND created_at >= date_trunc('month', NOW())
       AND created_at < date_trunc('month', NOW()) + INTERVAL '1 month'`,
    [businessId],
  );
  const leadsThisMonth = leadCountResult.rows[0]?.leads_this_month || 0;

  return {
    currentPlan: plan,
    plan: getPlanDefinition(plan),
    usage: {
      leadsThisMonth,
      monthlyLeadLimit,
      remainingLeadsThisMonth: monthlyLeadLimit == null ? null : Math.max(monthlyLeadLimit - leadsThisMonth, 0),
      leadLimitReached: monthlyLeadLimit != null && leadsThisMonth >= monthlyLeadLimit,
      leadEmailAlertsEnabled: canReceiveLeadEmails(plan),
    },
    plans: listSelectablePlans(),
  };
}

router.get('/plans', requireAuth, async (req, res) => {
  try {
    const snapshot = await getBillingSnapshot(req.business.businessId);
    if (!snapshot) return res.status(404).json({ error: 'Business not found' });
    return res.json(snapshot);
  } catch (error) {
    console.error('[billing/plans]', error.message);
    return res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

router.get('/usage', requireAuth, async (req, res) => {
  try {
    const snapshot = await getBillingSnapshot(req.business.businessId);
    if (!snapshot) return res.status(404).json({ error: 'Business not found' });
    return res.json({ currentPlan: snapshot.currentPlan, usage: snapshot.usage });
  } catch (error) {
    console.error('[billing/usage]', error.message);
    return res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

router.post('/select-plan', requireAuth, async (req, res) => {
  try {
    const selectedPlan = assertSelectablePlan(req.body?.plan);
    const result = await pool.query(
      `UPDATE businesses SET plan = $1, updated_at = NOW() WHERE id = $2 RETURNING id, plan, bot_id`,
      [selectedPlan, req.business.businessId],
    );
    const business = result.rows[0];
    if (!business) return res.status(404).json({ error: 'Business not found' });
    if (business.bot_id && redisClient) await redisClient.del(`chatbot_config:${business.bot_id}`);

    const snapshot = await getBillingSnapshot(req.business.businessId);
    return res.json({
      success: true,
      message: 'Plan selected: ' + getPlanDefinition(selectedPlan).label,
      requiresTokenRefresh: true,
      ...snapshot,
    });
  } catch (error) {
    console.error('[billing/select-plan]', error.message);
    return res.status(error.status || 500).json({ error: error.status ? error.message : 'Something went wrong. Please try again.' });
  }
});

export default router;
