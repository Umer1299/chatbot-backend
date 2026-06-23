import { Router } from 'express';
import pool from '../db/pool.js';
import requireAuth from '../middleware/jwtAuth.js';
import businessRoutes from './business.js';
import { getPlanDefinition, normalizePlan } from '../services/planService.js';

const router = Router();

router.get('/settings', requireAuth, async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM businesses WHERE id = $1', [req.business.businessId]);
  const business = rows[0] || null;

  if (!business) return res.json({ business: null });

  const publicPlan = normalizePlan(business.plan);
  return res.json({
    business: {
      ...business,
      stored_plan: business.plan,
      plan: publicPlan,
      planDetails: getPlanDefinition(publicPlan),
    },
  });
});

router.use(businessRoutes);

export default router;
