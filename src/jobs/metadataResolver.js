const GENERIC_PAGE_TITLES = new Set([
  'faq', 'contact', 'about', 'services', 'blog', 'home', 'privacy policy', 'terms', 'sitemap', 'login',
  'portfolio', 'pricing', 'features', 'our services', 'what we do', 'welcome',
]);

const SERVICE_KEYWORDS = ['service', 'solutions', 'construction', 'churches', 'clinic', 'dental', 'roofing', 'plumbing', 'agency', 'studio', 'media', 'law', 'marketing', 'renovation', 'building'];
const SUFFIX_SPLITS = ['group', 'services', 'solutions', 'construction', 'churches', 'clinic', 'dental', 'roofing', 'plumbing', 'agency', 'studio', 'media', 'law'];
const ACRONYMS = new Set(['uk', 'usa', 'nhs']);

function sanitizeTitle(title = '') {
  return String(title).split('|')[0].split(' - ')[0].trim();
}

function normalizeNameTokens(value = '') {
  return String(value).toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\b(the|and|ltd|llc|inc|limited|co|company)\b/g, ' ').replace(/\s+/g, ' ').trim();
}

function tokenSet(value = '') { return new Set(normalizeNameTokens(value).split(' ').filter((t) => t.length > 1)); }

function overlapRatio(a, b) { if (!a.size || !b.size) return 0; let n = 0; for (const t of a) if (b.has(t)) n += 1; return n / Math.min(a.size, b.size); }

export function deriveNameFromDomain(domain = '') {
  try {
    const host = new URL(domain).hostname.replace(/^www\./i, '');
    let root = (host.split('.')[0] || '').replace(/[-_]+/g, ' ');
    for (const suffix of SUFFIX_SPLITS) root = root.replace(new RegExp(`([a-z0-9])(${suffix})$`, 'i'), '$1 $2');
    return root.split(/\s+/).filter(Boolean).map((w) => (ACRONYMS.has(w.toLowerCase()) ? w.toUpperCase() : w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())).join(' ');
  } catch { return ''; }
}

function isServiceHeavy(name = '') {
  const tokens = normalizeNameTokens(name).split(' ').filter(Boolean);
  if (!tokens.length) return true;
  const hits = tokens.filter((t) => SERVICE_KEYWORDS.includes(t)).length;
  return hits / tokens.length >= 0.6;
}

export function resolveBusinessName({ pages = [], domain = '', existingBusinessName = '', aiBusinessName = '', systemPromptDraft = '', welcomeMessage = '' }) {
  const homepage = pages.find((p) => { try { return /^\/?$/.test(new URL(p?.url || '').pathname); } catch { return false; } }) || pages[0] || {};
  const combined = pages.map((p) => `${p?.title || ''}\n${p?.content || ''}`).join('\n');
  const domainName = deriveNameFromDomain(domain || homepage?.url || '');
  const ogSiteName = combined.match(/og:site_name[^\n:]*[:\s]+([^\n]+)/i)?.[1]?.trim() || '';
  const jsonLdName = combined.match(/"@type"\s*:\s*"(?:Organization|LocalBusiness)"[\s\S]*?"name"\s*:\s*"([^"]+)"/i)?.[1]?.trim() || '';
  const titleName = sanitizeTitle(homepage?.title || '');
  const h1Name = combined.match(/^#\s+(.+)$/m)?.[1]?.trim() || '';
  const promptName = systemPromptDraft.match(/(?:you are|for|at)\s+([A-Z][\w&'\- ]{1,40})/i)?.[1]?.trim() || '';
  const welcomeName = welcomeMessage.match(/welcome to\s+([A-Z][\w&'\- ]{1,40})/i)?.[1]?.trim() || '';

  const candidates = [
    { value: existingBusinessName, source: 'existing' }, { value: domainName, source: 'domain' }, { value: ogSiteName, source: 'og' },
    { value: jsonLdName, source: 'jsonld' }, { value: titleName, source: 'title' }, { value: h1Name, source: 'h1' },
    { value: aiBusinessName, source: 'ai' }, { value: promptName, source: 'prompt' }, { value: welcomeName, source: 'welcome' },
  ].map((c) => ({ ...c, value: String(c.value || '').trim() })).filter((c) => c.value);

  const domainTokens = tokenSet(domainName);
  const repeated = candidates.reduce((m, c) => { const k = normalizeNameTokens(c.value); m[k] = (m[k] || 0) + 1; return m; }, {});

  let best = { score: -999, value: domainName || 'Your Business' };
  for (const c of candidates) {
    const normalized = normalizeNameTokens(c.value);
    const words = normalized.split(' ').filter(Boolean);
    if (GENERIC_PAGE_TITLES.has(normalized) || words.length > 7 || isServiceHeavy(c.value)) continue;
    let score = 0;
    if (['og', 'jsonld'].includes(c.source)) score += 4;
    if (['welcome', 'prompt', 'ai'].includes(c.source)) score += 2;
    if (['domain', 'h1', 'title'].includes(c.source)) score += 1;
    score += (repeated[normalized] || 0) * 1.5;
    score += overlapRatio(tokenSet(c.value), domainTokens) * 3;
    if (c.source === 'existing' && overlapRatio(tokenSet(c.value), domainTokens) < 0.5) score -= 4;
    if (score > best.score) best = { score, value: c.value };
  }

  return best.value || domainName || 'Your Business';
}

export function resolveLogo({ pages = [], domain = '' }) {
  const text = pages.map((p) => p?.content || '').join('\n');
  const schemaLogo = text.match(/"logo"\s*:\s*"(https?:[^"\s]+)"/i)?.[1] || null;
  if (schemaLogo) return schemaLogo;
  const mdImages = [...text.matchAll(/!\[[^\]]*\]\((https?:[^)\s]+)(?:\s+"([^"]*)")?\)/gi)];
  for (const m of mdImages) {
    const url = m[1] || ''; const title = (m[2] || '').toLowerCase(); const full = `${url} ${title}`.toLowerCase();
    if (/(logo|brand|navbar|header|footer)/i.test(full) && !/(gallery|hero|banner|portrait|person|team|staff|testimonial|img_|photo|full-length)/i.test(full)) return url;
  }
  try { const origin = new URL(domain || pages[0]?.url || '').origin; return `${origin}/favicon.ico`; } catch { return null; }
}

export function sanitizeContactInfo({ extractedEmail = null, extractedPhone = null, domain = '' }) {
  const rejected = { email: null, phone: null };
  let email = extractedEmail;
  let phone = extractedPhone;
  const placeholderEmail = /^(test|info|demo|sample|noreply)@(?:example\.com|yourchurch\.com)/i.test(email || '') || /(demo|sample|noreply)@/i.test(email || '');
  if (placeholderEmail) { rejected.email = email; email = null; }
  const phoneDigits = String(phone || '').replace(/\D/g, '');
  const badPhone = ['12345678910', '1234567890', '01234567890', '0000000000'].includes(phoneDigits)
    || /^(\d)\1{9,}$/.test(phoneDigits)
    || '0123456789'.includes(phoneDigits)
    || /\+44\s*\(0\)1234\s*567890/.test(String(phone || ''));
  if (badPhone) { rejected.phone = phone; phone = null; }

  if (email) {
    try {
      const host = new URL(domain).hostname.replace(/^www\./, '');
      const emailDomain = email.split('@')[1]?.toLowerCase() || '';
      if (!(emailDomain === host || emailDomain.endsWith(`.${host}`) || host.endsWith(`.${emailDomain}`))) {
        rejected.email = email;
        email = null;
      }
    } catch { /* ignore */ }
  }
  return { verified: { email, phone }, rejected };
}

export function normalizeIndustry({ detectedIndustry = 'unknown', confidence = 0, services = [], text = '' }) {
  if (detectedIndustry && detectedIndustry !== 'unknown' && confidence >= 0.55) return detectedIndustry;
  const corpus = `${services.join(' ')} ${text}`.toLowerCase();
  const score = {
    web_agency: /(website|seo|branding|design|digital|marketing)/.test(corpus),
    construction: /(construction|builder|renovation|roofing|plumbing|fit out)/.test(corpus),
    real_estate: /(estate|property|lettings|realtor|mortgage)/.test(corpus),
    healthcare: /(clinic|dental|medical|patient|treatment)/.test(corpus),
    law_firm: /(solicitor|attorney|legal|lawyer|litigation)/.test(corpus),
  };
  return Object.entries(score).find(([, v]) => v)?.[0] || 'web_agency';
}

export function applyFinalConsistency({ result, welcomeMessage = '', systemPromptDraft = '', businessName = '', services = [] }) {
  const finalName = businessName || result.businessName;
  const replaceName = (text = '') => String(text || '')
    .replace(/welcome to\s+[\w&'\- ]+/i, `Welcome to ${finalName}`)
    .replace(/\b[A-Z][\w&'\- ]{2,40}\b(?= (?:provides|offers))/g, finalName)
    .replace(/(assistant for|for)\s+[A-Z][\w&'\- ]{1,40}/gi, `$1 ${finalName}`);
  return {
    ...result,
    businessName: finalName,
    businessSummary: replaceName(result.businessSummary || `${finalName} provides ${services.join(', ') || 'services'}.`),
    welcomeMessage: replaceName(welcomeMessage || result.welcomeMessage || ''),
    systemPromptDraft: replaceName(systemPromptDraft || result.systemPromptDraft || ''),
  };
}
