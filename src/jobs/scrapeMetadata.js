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
]);

function sanitizeTitle(title = '') {
  return String(title).split('|')[0].split('-')[0].trim();
}

function isGenericPageTitle(title = '') {
  return GENERIC_PAGE_TITLES.has(String(title).toLowerCase().trim());
}

function deriveNameFromDomain(url = '') {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.replace(/^www\./i, '');
    const root = host.split('.')[0] || '';
    return root
      .replace(/[-_]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .replace(/\b\w/g, (m) => m.toUpperCase());
  } catch {
    return '';
  }
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

  const candidates = [
    existingBusinessName,
    !isGenericPageTitle(fallback) ? fallback : '',
    ogSiteName,
    jsonLdOrgName,
    !isGenericPageTitle(homePageTitle) ? homePageTitle : '',
    firstValidTitle,
    deriveNameFromDomain(domain || homePage?.url || ''),
  ].map((value) => String(value || '').trim()).filter(Boolean);

  return candidates[0] || 'Your Business';
}
