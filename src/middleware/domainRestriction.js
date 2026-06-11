import { redisClient } from '../services/redis.js';

function normalizeHostname(value = '') {
  const raw = String(value || '').trim().toLowerCase();
  if (!raw) return '';

  try {
    return new URL(raw.includes('://') ? raw : `https://${raw}`).hostname.replace(/^www\./, '');
  } catch {
    return raw
      .replace(/^https?:\/\//, '')
      .replace(/^www\./, '')
      .split('/')[0]
      .split(':')[0]
      .trim();
  }
}

function getRequestHost(req) {
  const origin = req.headers.origin;
  const referer = req.headers.referer || req.headers.referrer;
  const host = req.headers.host;

  return normalizeHostname(origin || referer || host || '');
}

function isDomainAllowed(requestHost, allowedDomain) {
  const raw = String(allowedDomain || '').trim().toLowerCase();
  if (!raw) return false;

  if (raw === '*') return true;

  if (raw.startsWith('*.')) {
    const baseDomain = normalizeHostname(raw.slice(2));
    return requestHost === baseDomain || requestHost.endsWith(`.${baseDomain}`);
  }

  const allowedHost = normalizeHostname(raw);
  return requestHost === allowedHost || requestHost.endsWith(`.${allowedHost}`);
}

export async function domainRestriction(req, res, next) {
  const requestHost = getRequestHost(req);
  if (!requestHost) return next();

  const namespace = req.namespace;

  try {
    const settingsRaw = await redisClient.get(`chatbot:${namespace}`);
    if (!settingsRaw) return next();

    const settings = JSON.parse(settingsRaw);
    const allowedDomains = Array.isArray(settings.allowedDomains)
      ? settings.allowedDomains
      : [];

    if (allowedDomains.length === 0) return next();

    const isAllowed = allowedDomains.some((domain) => isDomainAllowed(requestHost, domain));

    if (!isAllowed) {
      console.warn('[domainRestriction] Domain not allowed', {
        namespace,
        requestHost,
        origin: req.headers.origin || null,
        referer: req.headers.referer || req.headers.referrer || null,
        allowedDomains,
      });

      return res.status(403).json({
        error: 'Domain not allowed',
        requestHost,
      });
    }

    return next();
  } catch (error) {
    console.error('[domainRestriction] Failed to validate domain:', error.message);
    return next();
  }
}
