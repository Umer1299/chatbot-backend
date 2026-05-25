import { deriveNameFromDomain, resolveBusinessName } from './metadataResolver.js';

function normalizeBusinessName(name = '') {
  return String(name || '')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\b(the|and|ltd|llc|inc|limited|group|co|company)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function toNameTokenSet(name = '') {
  const normalized = normalizeBusinessName(name);
  if (!normalized) return new Set();
  return new Set(normalized.split(' ').filter((token) => token.length > 1));
}

function overlapRatio(a = new Set(), b = new Set()) {
  if (!a.size || !b.size) return 0;
  let overlap = 0;
  for (const token of a) if (b.has(token)) overlap += 1;
  return overlap / Math.min(a.size, b.size);
}

export function isLikelySameBusinessName(existingName = '', domainName = '', scrapedName = '') {
  const existingTokens = toNameTokenSet(existingName);
  if (!existingTokens.size) return true;
  const domainOverlap = overlapRatio(existingTokens, toNameTokenSet(domainName));
  const scrapedOverlap = overlapRatio(existingTokens, toNameTokenSet(scrapedName));
  return domainOverlap >= 0.6 || scrapedOverlap >= 0.6;
}

export function extractBusinessNameFromPages(pages = [], options = {}) {
  const { fallback = '', existingBusinessName = '', domain = '', systemPromptDraft = '', welcomeMessage = '' } = typeof options === 'string' ? { fallback: options } : options;
  return resolveBusinessName({
    pages,
    domain,
    existingBusinessName,
    aiBusinessName: fallback,
    systemPromptDraft,
    welcomeMessage,
  });
}

export { deriveNameFromDomain };
