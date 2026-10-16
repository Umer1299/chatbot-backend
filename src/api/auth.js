import { Router } from 'express';
import jwt from 'jsonwebtoken';
import { requireAdminKey } from '../middleware/adminAuth.js';
import { JWT_OPTIONS } from '../middleware/jwtAuth.js';
import { v4 as uuidv4 } from 'uuid';
import pool from '../db/pool.js';
import { normalizePlan, toStoragePlan } from '../services/planService.js';

const router = Router();

// Trusted server-to-server bridge only. Never expose the admin key in a browser.
router.post('/token', requireAdminKey, async (req, res) => {
  try {
    const { bubbleUserId, email, businessName, industry } = req.body;

    if (typeof bubbleUserId !== 'string' || !bubbleUserId.trim() || typeof email !== 'string' || !email.trim()) {
      return res.status(400).json({ error: 'bubbleUserId and email are required' });
    }

    const existing = await pool.query(
      `SELECT *
       FROM businesses
       WHERE bubble_user_id = $1
       LIMIT 1`,
      [bubbleUserId],
    );

    let business = existing.rows[0];

    if (!business) {
      const botId = `bot_${uuidv4().replace(/-/g, '').substring(0, 12)}`;
      const inserted = await pool.query(
        `INSERT INTO businesses
          (bubble_user_id, business_name, industry, owner_email, bot_id, plan)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (bubble_user_id) DO UPDATE SET bubble_user_id=EXCLUDED.bubble_user_id
         RETURNING *`,
        [bubbleUserId, businessName || 'New Business', industry || 'other', email, botId, toStoragePlan('free')],
      );
      business = inserted.rows[0];
    }

    if (!business.active) return res.status(403).json({ error: 'Account inactive' });
    const publicPlan = normalizePlan(business.plan);
    const token = jwt.sign(
      {
        businessId: business.id,
        bubbleUserId: business.bubble_user_id,
        industry: business.industry,
        plan: publicPlan,
        botId: business.bot_id,
      },
      process.env.JWT_SECRET,
      { ...JWT_OPTIONS, subject: business.id },
    );

    return res.json({
      token,
      businessId: business.id,
      botId: business.bot_id,
      industry: business.industry,
      plan: publicPlan,
      onboardingComplete: business.onboarding_complete,
    });
  } catch (error) {
    console.error('AUTH_TOKEN_ERROR:', error);
    return res.status(500).json({ error: 'Failed to issue token' });
  }
});

export default router;
