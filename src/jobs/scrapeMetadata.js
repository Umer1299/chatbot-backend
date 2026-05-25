const GENERIC_PAGE_TITLES = new Set([
  'faq',
  'contact',
  'about',
  'services',
  'blog',
  'home',
  'privacy policy',
  'terms',
  'sitemap',
  'login',
  'our designs',
  'designs',
  'templates',
  'portfolio',
  'pricing',
  'features',
]);

const GENERIC_TITLE_PATTERNS = [
  /\bour services?\b/i,
  /\bwhat we do\b/i,
  /\bfacilities management\b/i,
  /\bconstruction services?\b/i,
  /\bbuilding services?\b/i,
  /\brenovation services?\b/i,
  /\bfit[\s-]?out services?\b/i,
  /\bbuilding[,/&\s]+renovation[,/&\s]+(?:&\s*)?construction services?\b/i,
];

function sanitizeTitle(title = '') {
  return String(title).split('|')[0].split('-')[0].trim();
}

function isGenericPageTitle(title = '') {
  const normalizedTitle = String(title).toLowerCase().trim();
  if (!normalizedTitle) return true;
  if (GENERIC_PAGE_TITLES.has(normalizedTitle)) return true;
  return GENERIC_TITLE_PATTERNS.some((pattern) => pattern.test(normalizedTitle));
}

function splitCompositeRootToken(root = '') {
  const knownSuffixes = ['group', 'services', 'construction', 'churches'];
  for (const suffix of knownSuffixes) {
    const suffixPattern = new RegExp(`^([a-z0-9]+)(${suffix})$`, 'i');
    const match = root.match(suffixPattern);
    if (match) return `${match[1]} ${match[2]}`;
  }
  return root;
}

function deriveNameFromDomain(url = '') {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.replace(/^www\./i, '');
    const root = splitCompositeRootToken(host.split('.')[0] || '');
    if (!root) return '';

    return root
      .replace(/[-_]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .replace(/\b\w/g, (m) => m.toUpperCase())
      .replace(/\bUk\b/g, 'UK');
  } catch {
    return '';
  }
}

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
  for (const token of a) {
    if (b.has(token)) overlap += 1;
  }
  return overlap / Math.min(a.size, b.size);
}

export function isLikelySameBusinessName(existingName = '', domainName = '', scrapedName = '') {
  const existingTokens = toNameTokenSet(existingName);
  if (!existingTokens.size) return true;

  const domainTokens = toNameTokenSet(domainName);
  const scrapedTokens = toNameTokenSet(scrapedName);

  const domainOverlap = overlapRatio(existingTokens, domainTokens);
  const scrapedOverlap = overlapRatio(existingTokens, scrapedTokens);

  return domainOverlap >= 0.6 || scrapedOverlap >= 0.6;
}

export function extractBusinessNameFromPages(pages = [], options = {}) {
  const {
    fallback = '',
    existingBusinessName = '',
    domain = '',
  } = typeof options === 'string' ? { fallback: options } : options;

  const allText = pages.map((p) => `${p?.title || ''}\n${p?.content || ''}`).join('\n');
  const isHomepageUrl = (value = '') => {
    try {
      return /^\/?$/.test(new URL(value).pathname);
    } catch {
      return false;
    }
  };
  const homePage = pages.find((p) => isHomepageUrl(p?.url || '')) || pages[0] || {};
  const homePageTitle = sanitizeTitle(homePage?.title || '');
  const firstValidTitle = pages
    .map((p) => sanitizeTitle(p?.title || ''))
    .find((title) => title && !isGenericPageTitle(title));
  const ogSiteName = allText.match(/og:site_name[^\n:]*[:\s]+([^\n]+)/i)?.[1]?.trim() || '';
  const jsonLdOrgName = allText.match(/"@type"\s*:\s*"(?:Organization|LocalBusiness)"[\s\S]*?"name"\s*:\s*"([^"]+)"/i)?.[1]?.trim() || '';
  const domainName = deriveNameFromDomain(domain || homePage?.url || '');
  const fallbackName = !isGenericPageTitle(fallback) ? fallback : '';
  const safeExistingName = !isGenericPageTitle(existingBusinessName)
    && isLikelySameBusinessName(existingBusinessName, domainName, fallbackName || homePageTitle || firstValidTitle)
    ? existingBusinessName
    : '';

  const candidates = [
    safeExistingName,
    ogSiteName,
    jsonLdOrgName,
    domainName,
    fallbackName,
    !isGenericPageTitle(homePageTitle) ? homePageTitle : '',
    firstValidTitle,
  ].map((value) => String(value || '').trim()).filter(Boolean);

  return candidates[0] || 'Your Business';
}

export { deriveNameFromDomain };
