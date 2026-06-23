import { Router } from 'express';
import jwt from 'jsonwebtoken';
import { v4 as uuidv4 } from 'uuid';
import pool from '../db/pool.js';

const router = Router();

router.post('/token', async (req, res) => {
  try {
    const { bubbleUserId, email, businessName, industry } = req.body;

    if (!bubbleUserId || !email) {
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
         VALUES ($1, $2, $3, $4, $5, 'free')
         RETURNING *`,
        [bubbleUserId, businessName || 'New Business', industry || 'other', email, botId],
      );
      business = inserted.rows[0];
    }

    const token = jwt.sign(
      {
        businessId: business.id,
        bubbleUserId: business.bubble_user_id,
        industry: business.industry,
        plan: business.plan,
        botId: business.bot_id,
      },
      process.env.JWT_SECRET,
    );

    return res.json({
      token,
      businessId: business.id,
      botId: business.bot_id,
      industry: business.industry,
      plan: business.plan,
      onboardingComplete: business.onboarding_complete,
    });
  } catch (error) {
    console.error('AUTH_TOKEN_ERROR:', error);
    return res.status(500).json({ error: 'Failed to issue token' });
  }
});

export default router;
