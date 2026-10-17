import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import RedisStore from 'rate-limit-redis';
import { redisClient } from '../services/redis.js';

export const ipQuotaKey = req => ipKeyGenerator(req.ip);

function limiter(prefix, max, keyGenerator) {
  return rateLimit({
    store: new RedisStore({ prefix: `rl:${prefix}:`, sendCommand: (...args) => redisClient.call(...args) }),
    keyGenerator,
    windowMs: 60 * 1000,
    max,
    message: { error: 'Too many requests' },
    standardHeaders: true,
  });
}

// Public/authentication requests cannot choose their quota by changing headers.
export const authRateLimiter = limiter('auth', 120, ipQuotaKey);
export const publicReadLimiter = limiter('public-read', 120, ipQuotaKey);
export const adminRateLimiter = limiter('admin', 120, ipQuotaKey);

// Mounted only AFTER requireAuth has verified the JWT and current DB identity.
// Business is the current legacy subject; future user/member quotas are separate work.
const verifiedBusinessKey = req => {
  if (!req.auth?.businessId) throw new Error('Authenticated quota requires verified identity');
  return req.auth.businessId;
};
export const dashboardLimiter = limiter('dashboard', 120, verifiedBusinessKey);

const verifiedWidgetKey = req => {
  if (!req.namespace || !req.chatbotToken) throw new Error('Widget quota requires verified token');
  return `${req.namespace}:${ipQuotaKey(req)}`;
};
export const widgetLimiter = limiter('widget', 60, verifiedWidgetKey);
export const sessionRateLimiter = limiter('session', 30, verifiedWidgetKey);

// Independent account namespace: IP before authentication, verified user after it.
export const accountIpLimiter = limiter('account-ip', 120, ipQuotaKey);
// Coarse pre-session abuse ceiling: 50 full user quotas per IP, separate from login.
// This bounds invalid-cookie DB work without applying the 120/min user quota to a shared IP.
export const accountLookupLimiter = limiter('account-lookup', 6000, ipQuotaKey);
export const accountUserLimiter = limiter('account-user', 120, req => {
  if (!req.accountUser?.id) throw new Error('Account quota requires verified user');
  return req.accountUser.id;
});
