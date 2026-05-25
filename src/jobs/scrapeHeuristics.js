export function extractBrandData(pages = [], baseUrl = '') {
  const allText = pages.map((p) => `${p.title || ''}
${p.content || ''}`).join('\n');
  const firstPage = pages[0] || {};
  const titleCandidate = (firstPage.title || '').split('|')[0].split('-')[0].trim();
  const orgMatch = allText.match(/organization\"?\s*:\s*\"?([^\"\n]+)/i);
  const ogSiteName = allText.match(/og:site_name[^\n:]*[:\s]+([^\n]+)/i);
  const headerMatch = allText.match(/^#\s+(.{2,80})/m);
  const businessName = titleCandidate || orgMatch?.[1]?.trim() || ogSiteName?.[1]?.trim() || headerMatch?.[1]?.trim() || 'Your Business';

  const imageMatches = [...allText.matchAll(/!\[([^\]]*)\]\(([^)]+)\)/g)].map((m) => ({ alt: (m[1] || '').trim(), rawUrl: (m[2] || '').trim() }));
  const cleanedImageMatches = imageMatches.map((entry) => ({
    alt: entry.alt,
    url: entry.rawUrl.replace(/\s+["'][^"']*["']\s*$/, '').trim(),
  }));
  const logoCandidate = cleanedImageMatches.find(({ url, alt }) => /logo|brand|site-logo|header-logo|navbar-logo/i.test(`${url} ${alt}`));
  const logoUrl = logoCandidate?.url || null;
  const normalizedBase = baseUrl.replace(/\/+$/, '');
  const faviconUrl = `${normalizedBase}/favicon.ico`;

  const colorMatches = [...new Set((allText.match(/#(?:[0-9a-fA-F]{3}){1,2}\b/g) || []).map((c) => c.toUpperCase()))];
  const primaryColor = colorMatches[0] || '#1F6FEB';
  const secondaryColor = colorMatches[1] || '#111827';

  const fontMatches = [...new Set((allText.match(/font-family\s*:\s*([^;\n]+)/gi) || []).map((f) => f.split(':')[1].trim().replace(/["']/g, '')))].slice(0, 5);

  return { businessName, logoUrl, faviconUrl, primaryColor, secondaryColor, fonts: fontMatches };
}

export function normalizeIndustryFallback(analysisResult = {}, text = '') {
  const sourceText = [text, ...(Array.isArray(analysisResult.primaryServices) ? analysisResult.primaryServices : []), analysisResult.summary || ''].join(' ').toLowerCase();
  const shouldUseWebAgency = /website design|web design|website templates|hosting|branding|digital presence|ministry website|church website/.test(sourceText);
  if ((analysisResult.industry || 'unknown') === 'unknown' && shouldUseWebAgency) {
    return { ...analysisResult, industry: 'web_agency', confidence: Math.max(Number(analysisResult.confidence) || 0, 0.72) };
  }
  return analysisResult;
}
