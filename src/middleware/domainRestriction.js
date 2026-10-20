import { getChatbotSettings } from '../services/chatbotSettings.js';

import { parseHttpOrigin } from './corsPolicy.js';

function normalizeHostname(value = '') {
  try {
    const raw = String(value).trim();
    const url = new URL(raw.includes('://') ? raw : `https://${raw}`);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || !url.hostname) return '';
    return url.hostname.replace(/^www\./, '');
  } catch { return ''; }
}

function getRequestHost(req) {
  if (req.headers.origin !== undefined) {
    return parseHttpOrigin(req.headers.origin)?.hostname.replace(/^www\./, '') || '';
  }
  const referer = req.headers.referer || req.headers.referrer;
  if (referer) return normalizeHostname(referer);
  return null; // Server-to-server: Origin cannot be used as identity proof.
}

function isDomainAllowed(requestHost, allowedDomain) {
  const raw = String(allowedDomain || '').trim().toLowerCase();
  if (!raw) return false;

  if (raw === '*') return true;

  if (raw.startsWith('*.')) {
    const baseDomain = normalizeHostname(raw.slice(2));
    return Boolean(baseDomain) && (requestHost === baseDomain || requestHost.endsWith(`.${baseDomain}`));
  }

  const allowedHost = normalizeHostname(raw);
  return Boolean(allowedHost) && (requestHost === allowedHost || requestHost.endsWith(`.${allowedHost}`));
}

export async function domainRestriction(req, res, next) {
  const requestHost = getRequestHost(req);

  const namespace = req.namespace;

  try {
    const settings = await getChatbotSettings(namespace);
    const allowedDomains = settings.allowedDomains;

    if (requestHost === '') return res.status(403).json({ error: 'Invalid origin' });
    if (requestHost === null || allowedDomains.length === 0) return next();

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
    return next(error);
  }
}
