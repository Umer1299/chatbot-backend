import { redisClient } from '../services/redis.js';

function normalizeDomain(value) {
  if (!value) return '';

  let raw = String(value).trim().toLowerCase();

  // Support wildcard domains like *.example.com
  const isWildcard = raw.startsWith('*.');
  if (isWildcard) {
    raw = raw.slice(2);
  }

  // Remove protocol if saved as https://example.com or http://example.com
  raw = raw.replace(/^https?:\/\//, '');

  // Remove path/query/hash if saved as example.com/page?x=1#section
  raw = raw.split('/')[0].split('?')[0].split('#')[0];

  // Remove port if saved as example.com:443
  raw = raw.replace(/:\d+$/, '');

  // Remove trailing dot
  raw = raw.replace(/\.$/, '');

  // Remove leading www for easier matching
  raw = raw.replace(/^www\./, '');

  return isWildcard ? `*.${raw}` : raw;
}

function domainMatches(originHost, allowedDomain) {
  const origin = normalizeDomain(originHost);
  const allowed = normalizeDomain(allowedDomain);

  if (!origin || !allowed) return false;

  // Exact match: example.com === example.com
  if (origin === allowed) return true;

  // Wildcard match: *.example.com allows example.com and any subdomain
  if (allowed.startsWith('*.')) {
    const baseDomain = allowed.slice(2);
    return origin === baseDomain || origin.endsWith(`.${baseDomain}`);
  }

  // If allowed is example.com, allow subdomains such as www.example.com/app.example.com
  return origin.endsWith(`.${allowed}`);
}

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

  let settings;
  try {
    settings = JSON.parse(settingsRaw);
  } catch (error) {
    console.warn('[domainRestriction] Invalid chatbot settings JSON', {
      namespace,
      error: error.message
    });
    return next();
  }

  const allowedDomains = Array.isArray(settings.allowedDomains)
    ? settings.allowedDomains
    : [];

  if (allowedDomains.length === 0) return next();

  const isAllowed = allowedDomains.some(domain => domainMatches(originHost, domain));

  if (!isAllowed) {
    console.warn('[domainRestriction] Domain not allowed', {
      namespace,
      origin,
      originHost,
      normalizedOriginHost: normalizeDomain(originHost),
      allowedDomains,
      normalizedAllowedDomains: allowedDomains.map(normalizeDomain)
    });

    return res.status(403).json({
      error: 'Domain not allowed',
      origin: normalizeDomain(originHost),
      allowedDomains: allowedDomains.map(normalizeDomain)
    });
  }

  next();
}
