import jwt from 'jsonwebtoken';
import pool from '../db/pool.js';
import { normalizePlan } from '../services/planService.js';

export const JWT_OPTIONS = {
  algorithm: 'HS256', issuer: 'chatflow-api', audience: 'chatflow-dashboard', expiresIn: '1h',
};
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function requireAuth(req, res, next) {
  const match = /^Bearer ([^\s]+)$/i.exec(req.headers.authorization || '');
  if (!match) return res.status(401).json({ error: 'Bearer token required' });
  if (!process.env.JWT_SECRET) return res.status(503).json({ error: 'Authentication unavailable' });

  let decoded;
  try {
    decoded = jwt.verify(match[1], process.env.JWT_SECRET, {
      algorithms: ['HS256'], issuer: JWT_OPTIONS.issuer, audience: JWT_OPTIONS.audience,
      maxAge: '1h',
    });
    if (!decoded || typeof decoded !== 'object' || !UUID.test(decoded.businessId || '') ||
        decoded.sub !== decoded.businessId || !Number.isFinite(decoded.exp) ||
        !Number.isFinite(decoded.iat) || decoded.iat > Math.floor(Date.now() / 1000)) {
      throw new Error('Invalid claims');
    }
  } catch {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }

  try {
    // Reload identity and entitlements; client claims never override current DB state.
    const { rows } = await pool.query(
      'SELECT id, bubble_user_id, industry, plan, bot_id, active FROM businesses WHERE id=$1',
      [decoded.businessId],
    );
    const business = rows[0];
    if (!business || business.active !== true || business.bubble_user_id !== decoded.bubbleUserId) {
      return res.status(401).json({ error: 'Invalid or inactive account' });
    }
    req.business = { businessId: business.id, bubbleUserId: business.bubble_user_id,
      industry: business.industry, plan: normalizePlan(business.plan), botId: business.bot_id };
    return next();
  } catch (error) {
    return next(error);
  }
}

export default requireAuth;
