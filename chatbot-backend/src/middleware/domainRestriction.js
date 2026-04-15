import { redisClient } from '../services/redis.js';

export async function domainRestriction(req, res, next) {
  const origin = req.headers.origin;
  if (!origin) return next();

  let originHost;
  try {
    originHost = new URL(origin).hostname;
  } catch {
    return res.status(403).json({ error: 'Invalid origin' });
  }

  const namespace = req.namespace;
  const settingsRaw = await redisClient.get(`chatbot:${namespace}`);
  if (!settingsRaw) return next();
  const settings = JSON.parse(settingsRaw);
  const allowedDomains = settings.allowedDomains || [];
  if (allowedDomains.length === 0) return next();

  const isAllowed = allowedDomains.some(domain => {
    if (originHost === domain) return true;
    if (domain.startsWith('*.')) {
      const baseDomain = domain.slice(2);
      if (originHost.endsWith(`.${baseDomain}`)) return true;
    }
    return false;
  });

  if (!isAllowed) {
    return res.status(403).json({ error: 'Domain not allowed' });
  }
  next();
}