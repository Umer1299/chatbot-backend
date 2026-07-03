import * as cheerio from 'cheerio';

const DEFAULT_EXCLUDE_PATHS = [
  '/blog/*',
  '/news/*',
  '/tag/*',
  '/author/*',
  '/page/*',
  '/wp-admin/*',
  '/cdn-cgi/*',
  '/privacy*',
  '/terms*',
  '/cookie*',
  '/sitemap*',
  '/feed*',
  '/rss*',
];

const EXCLUDE_LINE_PATTERNS = [
  /we use cookies/i,
  /all rights reserved/i,
  /privacy policy/i,
  /subscribe to our newsletter/i,
  /follow us on/i,
  /copyright \d{4}/i,
  /terms (of service|and conditions)/i,
];

const FIRECRAWL_TIMEOUT_MS = Number(process.env.FIRECRAWL_TIMEOUT_MS || 120000);
const FIRECRAWL_POLL_INTERVAL_MS = Number(process.env.FIRECRAWL_POLL_INTERVAL_MS || 3000);
const FIRECRAWL_REQUEST_TIMEOUT_MS = Number(process.env.FIRECRAWL_REQUEST_TIMEOUT_MS || 30000);
const FIRECRAWL_EMPTY_COMPLETION_GRACE_MS = Number(process.env.FIRECRAWL_EMPTY_COMPLETION_GRACE_MS || 10000);
const FIRECRAWL_WAIT_FOR_MS = Number(process.env.FIRECRAWL_WAIT_FOR_MS || 1500);
const DIRECT_HTML_MIN_CHARS = Number(process.env.DIRECT_HTML_MIN_CHARS || 300);
const OFFICIAL_FIRECRAWL_URL = 'https://api.firecrawl.dev';

function stripTrailingSlash(value) {
  return String(value || '').trim().replace(/\/+$/, '');
}

function isOfficialFirecrawlUrl(baseUrl) {
  return stripTrailingSlash(baseUrl) === OFFICIAL_FIRECRAWL_URL;
}

function getFirecrawlBaseUrls() {
  const configured = [process.env.GCP_VM_URL, process.env.FIRECRAWL_API_URL]
    .map(stripTrailingSlash)
    .filter(Boolean);

  const officialApiKey = process.env.FIRECRAWL_OFFICIAL_API_KEY?.trim();
  const shouldFallbackToOfficial = process.env.FIRECRAWL_FALLBACK_TO_OFFICIAL === 'true' || Boolean(officialApiKey);
  const urls = shouldFallbackToOfficial ? [...configured, OFFICIAL_FIRECRAWL_URL] : configured;

  return [...new Set(urls.length ? urls : [OFFICIAL_FIRECRAWL_URL])];
}

function truncateBody(value, maxLength = 300) {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength);
}

function toBasicAuth(value) {
  if (!value) return null;
  return `Basic ${Buffer.from(value).toString('base64')}`;
}

function getFirecrawlHeaders(baseUrl, includeJsonContentType = false) {
  const headers = {};

  if (includeJsonContentType) {
    headers['Content-Type'] = 'application/json';
  }

  if (isOfficialFirecrawlUrl(baseUrl)) {
    const officialApiKey = process.env.FIRECRAWL_OFFICIAL_API_KEY?.trim() || process.env.FIRECRAWL_API_KEY?.trim();
    if (officialApiKey) {
      headers.Authorization = `Bearer ${officialApiKey}`;
    }
    return headers;
  }

  const customAuthorization = process.env.FIRECRAWL_SELF_HOSTED_AUTHORIZATION?.trim();
  const basicAuth = process.env.FIRECRAWL_BASIC_AUTH?.trim();
  const selfHostedApiKey = process.env.FIRECRAWL_SELF_HOSTED_API_KEY?.trim() || process.env.FIRECRAWL_API_KEY?.trim();

  if (customAuthorization) {
    headers.Authorization = customAuthorization;
  } else if (basicAuth) {
    headers.Authorization = toBasicAuth(basicAuth);
  } else if (selfHostedApiKey) {
    headers['x-api-key'] = selfHostedApiKey;
  }

  return headers;
}

async function fetchWithTimeout(url, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FIRECRAWL_REQUEST_TIMEOUT_MS);

  try {
    return await fetch(url, {
      ...options,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }
}

async function readJsonResponse(response, context) {
  const contentType = response.headers.get('content-type') || '';
  const rawBody = await response.text();

  if (!contentType.includes('application/json')) {
    throw new Error(
      `${context} returned non-JSON response (${response.status} ${response.statusText}). Body: ${truncateBody(rawBody)}`,
    );
  }

  try {
    return rawBody ? JSON.parse(rawBody) : {};
  } catch (error) {
    throw new Error(`${context} returned invalid JSON. Body: ${truncateBody(rawBody)}`);
  }
}

function normalizeWebsiteUrl(value) {
  const raw = String(value || '').trim();
  if (!raw) return raw;
  if (/^https?:\/\//i.test(raw)) return raw;
  return `https://${raw.replace(/^\/+/, '')}`;
}

function getUrlCandidates(value) {
  const normalized = normalizeWebsiteUrl(value);
  if (!normalized) return [];

  const candidates = [normalized];
  if (normalized.startsWith('https://')) {
    candidates.push(normalized.replace(/^https:\/\//i, 'http://'));
  }

  return [...new Set(candidates)];
}

function normalizePage(page) {
  const metadata = page?.metadata || {};
  const content = page?.markdown || page?.content || page?.html || page?.rawHtml || page?.summary || '';

  return {
    url: page?.url || metadata?.sourceURL || metadata?.url || '',
    content,
    title: metadata?.title || page?.title || '',
    metadata,
  };
}

function extractPages(payload) {
  const candidates = [
    payload?.data?.pages,
    payload?.pages,
    payload?.data?.data,
    payload?.data,
  ];

  const pageCandidate = candidates.find((candidate) => Array.isArray(candidate) || (candidate && typeof candidate === 'object'));
  const pages = Array.isArray(pageCandidate) ? pageCandidate : pageCandidate ? [pageCandidate] : [];

  return pages
    .map(normalizePage)
    .filter((page) => String(page.content || '').trim());
}

function getStatus(payload) {
  return String(payload?.status || payload?.data?.status || '').toLowerCase();
}

function getCount(payload, key) {
  const value = payload?.[key] ?? payload?.data?.[key];
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function getPayloadError(payload) {
  return (
    payload?.error ||
    payload?.message ||
    payload?.data?.error ||
    payload?.data?.message ||
    payload?.data?.metadata?.error ||
    null
  );
}

function getNextUrl(payload) {
  return payload?.next || payload?.data?.next || null;
}

function resolveFirecrawlUrl(baseUrl, value) {
  if (!value) return null;
  try {
    return new URL(value, `${baseUrl}/`).toString();
  } catch {
    return null;
  }
}

async function fetchPaginatedPages(baseUrl, firstNextUrl) {
  const pages = [];
  const seen = new Set();
  let nextUrl = resolveFirecrawlUrl(baseUrl, firstNextUrl);

  while (nextUrl && !seen.has(nextUrl)) {
    seen.add(nextUrl);

    const response = await fetchWithTimeout(nextUrl, {
      method: 'GET',
      headers: getFirecrawlHeaders(baseUrl),
    });
    const payload = await readJsonResponse(response, `Firecrawl paginated crawl at ${nextUrl}`);

    if (!response.ok) {
      throw new Error(getPayloadError(payload) || `Crawl pagination failed (${response.status})`);
    }

    pages.push(...extractPages(payload));
    nextUrl = resolveFirecrawlUrl(baseUrl, getNextUrl(payload));
  }

  return pages;
}

function buildScrapeOptions(options = {}) {
  const scrapeOptions = {
    formats: ['markdown'],
    onlyMainContent: options.onlyMainContent ?? false,
    excludeTags: ['script', 'style', 'nav', 'footer', 'header', 'aside', '.cookie-banner', '#cookie'],
    waitFor: options.waitFor ?? FIRECRAWL_WAIT_FOR_MS,
    timeout: options.timeout ?? FIRECRAWL_REQUEST_TIMEOUT_MS,
    removeBase64Images: true,
    blockAds: true,
  };

  return scrapeOptions;
}

function htmlToBusinessText(html) {
  const $ = cheerio.load(html || '');

  $('script, style, noscript, svg, canvas, iframe, form').remove();

  const selectors = [
    'h1',
    'h2',
    'h3',
    'h4',
    'p',
    'li',
    '.elementor-widget-container',
    '.elementor-heading-title',
    '.elementor-icon-list-text',
    '[class*=service]',
    '[class*=about]',
    '[class*=testimonial]',
  ];
  const seen = new Set();
  const sections = [];

  for (const selector of selectors) {
    $(selector).each((_, element) => {
      const text = $(element).text().replace(/\s+/g, ' ').trim();
      const key = text.toLowerCase();
      if (text.length < 35) return;
      if (text.split('|').length - 1 > 5) return;
      if (seen.has(key)) return;
      seen.add(key);
      sections.push(text);
    });
  }

  let combined = sections.join('\n\n').trim();

  if (combined.length < DIRECT_HTML_MIN_CHARS) {
    combined = $('body').text().replace(/\s+/g, ' ').trim();
  }

  return combined;
}

function extractHtmlMetadata($) {
  return {
    title: $('title').first().text().trim(),
    description: $('meta[name="description"]').attr('content') || '',
    ogDescription: $('meta[property="og:description"]').attr('content') || '',
    ogImage: $('meta[property="og:image"]').attr('content') || '',
    themeColor: $('meta[name="theme-color"]').attr('content') || '',
  };
}

async function scrapeDirectHtml(url) {
  const errors = [];

  for (const candidateUrl of getUrlCandidates(url)) {
    try {
      const response = await fetchWithTimeout(candidateUrl, {
        method: 'GET',
        redirect: 'follow',
        headers: {
          Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'User-Agent': 'Mozilla/5.0 (compatible; ChatflowAIBot/1.0; +https://chatflowai.io)',
        },
      });

      const rawBody = await response.text();
      if (!response.ok) {
        throw new Error(`HTTP ${response.status} ${response.statusText}: ${truncateBody(rawBody)}`);
      }

      const contentType = response.headers.get('content-type') || '';
      if (contentType && !contentType.includes('text/html') && !contentType.includes('application/xhtml+xml')) {
        throw new Error(`Unexpected content type: ${contentType}`);
      }

      const $ = cheerio.load(rawBody);
      const content = htmlToBusinessText(rawBody);
      if (content.length < DIRECT_HTML_MIN_CHARS) {
        throw new Error(`Direct HTML extraction returned too little content (${content.length} chars)`);
      }

      const metadata = extractHtmlMetadata($);
      const page = {
        url: response.url || candidateUrl,
        content,
        title: metadata.title || new URL(candidateUrl).hostname,
        metadata: {
          ...metadata,
          sourceURL: response.url || candidateUrl,
          extractionFallback: 'direct-html',
        },
      };

      console.log(
        `[firecrawlService] direct HTML fallback returned ${content.length} characters for ${url} via ${candidateUrl}`,
      );
      return [page];
    } catch (error) {
      errors.push(`${candidateUrl}: ${error.message}`);
    }
  }

  throw new Error(`Direct HTML fallback failed: ${errors.join(' | ')}`);
}

async function startCrawl(baseUrl, url, options) {
  const crawlUrl = `${baseUrl}/v1/crawl`;
  const crawlOptions = {
    url: normalizeWebsiteUrl(url),
    limit: options.limit || 20,
    maxDepth: options.maxDepth || 2,
    maxDiscoveryDepth: options.maxDiscoveryDepth || options.maxDepth || 2,
    scrapeOptions: buildScrapeOptions(options),
    excludePaths: options.excludePaths || DEFAULT_EXCLUDE_PATHS,
  };

  if (process.env.FIRECRAWL_IGNORE_ROBOTS_TXT === 'true') {
    crawlOptions.ignoreRobotsTxt = true;
  }

  const response = await fetchWithTimeout(crawlUrl, {
    method: 'POST',
    headers: getFirecrawlHeaders(baseUrl, true),
    body: JSON.stringify(crawlOptions),
  });

  const payload = await readJsonResponse(response, `Firecrawl start crawl at ${crawlUrl}`);

  if (!response.ok) {
    throw new Error(getPayloadError(payload) || `Failed to start crawl (${response.status})`);
  }

  return payload;
}

async function scrapeSinglePage(baseUrl, url, options = {}) {
  const scrapeUrl = `${baseUrl}/v1/scrape`;
  const response = await fetchWithTimeout(scrapeUrl, {
    method: 'POST',
    headers: getFirecrawlHeaders(baseUrl, true),
    body: JSON.stringify({
      url: normalizeWebsiteUrl(url),
      ...buildScrapeOptions(options),
    }),
  });

  const payload = await readJsonResponse(response, `Firecrawl fallback scrape at ${scrapeUrl}`);

  if (!response.ok) {
    throw new Error(getPayloadError(payload) || `Fallback scrape failed (${response.status})`);
  }

  const pages = extractPages(payload);
  if (!pages.length) {
    throw new Error(getPayloadError(payload) || 'Fallback scrape returned no usable page content');
  }

  return pages;
}

async function pollCrawl(baseUrl, jobId) {
  const pollUrl = `${baseUrl}/v1/crawl/${jobId}`;
  const start = Date.now();
  let emptyCompletionStartedAt = null;

  while (Date.now() - start < FIRECRAWL_TIMEOUT_MS) {
    const pollResp = await fetchWithTimeout(pollUrl, {
      method: 'GET',
      headers: getFirecrawlHeaders(baseUrl),
    });

    const pollPayload = await readJsonResponse(pollResp, `Firecrawl poll crawl at ${pollUrl}`);

    if (!pollResp.ok) {
      throw new Error(getPayloadError(pollPayload) || `Crawl polling failed (${pollResp.status})`);
    }

    const status = getStatus(pollPayload);
    const completed = getCount(pollPayload, 'completed');
    const total = getCount(pollPayload, 'total');
    const pages = extractPages(pollPayload);
    const nextUrl = getNextUrl(pollPayload);

    if (nextUrl) {
      pages.push(...await fetchPaginatedPages(baseUrl, nextUrl));
    }

    console.log(
      `[firecrawlService] poll ${jobId}: status=${status || 'unknown'} pages=${pages.length} completed=${completed ?? 'unknown'} total=${total ?? 'unknown'}`,
    );

    if (pages.length > 0) {
      return pages;
    }

    if (status === 'failed' || status === 'cancelled') {
      throw new Error(getPayloadError(pollPayload) || `Firecrawl crawl ${status}`);
    }

    if (status === 'completed' || status === 'complete') {
      throw new Error(
        getPayloadError(pollPayload) ||
          `Firecrawl crawl completed but returned no usable page content (completed=${completed ?? 'unknown'}, total=${total ?? 'unknown'})`,
      );
    }

    if (total && completed != null && completed >= total) {
      if (!emptyCompletionStartedAt) {
        emptyCompletionStartedAt = Date.now();
      }

      if (Date.now() - emptyCompletionStartedAt >= FIRECRAWL_EMPTY_COMPLETION_GRACE_MS) {
        throw new Error(
          getPayloadError(pollPayload) ||
            `Firecrawl crawl appears finished but returned no usable page content (status=${status || 'unknown'}, completed=${completed}, total=${total})`,
        );
      }
    } else {
      emptyCompletionStartedAt = null;
    }

    await new Promise((resolve) => setTimeout(resolve, FIRECRAWL_POLL_INTERVAL_MS));
  }

  throw new Error(`Firecrawl crawl timed out after ${Math.round(FIRECRAWL_TIMEOUT_MS / 1000)} seconds`);
}

async function scrapeWithBaseUrl(baseUrl, url, options) {
  try {
    const payload = await startCrawl(baseUrl, url, options);
    const jobId = payload?.jobId || payload?.id || payload?.data?.jobId || payload?.data?.id;
    const pages = jobId ? await pollCrawl(baseUrl, jobId) : extractPages(payload);

    if (pages.length) {
      return pages;
    }

    throw new Error('Firecrawl crawl returned no usable page content');
  } catch (crawlError) {
    console.warn(
      `[firecrawlService] crawl failed for ${url} via ${baseUrl}; trying single-page scrape fallback. Reason: ${crawlError.message}`,
    );

    try {
      const fallbackPages = await scrapeSinglePage(baseUrl, url, options);
      console.log(`[firecrawlService] fallback scrape returned ${fallbackPages.length} page(s) for ${url} via ${baseUrl}`);
      return fallbackPages;
    } catch (singlePageError) {
      console.warn(
        `[firecrawlService] single-page scrape fallback failed for ${url} via ${baseUrl}; trying direct HTML fallback. Reason: ${singlePageError.message}`,
      );
      return scrapeDirectHtml(url);
    }
  }
}

export async function scrapeWebsite(url, options = {}) {
  const baseUrls = getFirecrawlBaseUrls();

  if (!baseUrls.length) {
    return { pages: [], totalPages: 0, error: 'Missing Firecrawl URL configuration' };
  }

  const errors = [];

  for (const baseUrl of baseUrls) {
    try {
      const normalizedPages = await scrapeWithBaseUrl(baseUrl, url, options);

      if (!normalizedPages.length) {
        throw new Error('Firecrawl returned no usable page content');
      }

      console.log(`Scraped ${normalizedPages.length} pages from ${url} via ${baseUrl}`);

      return {
        pages: normalizedPages,
        totalPages: normalizedPages.length,
        error: null,
      };
    } catch (error) {
      const message = `${baseUrl}: ${error.message}`;
      errors.push(message);
      console.error('[firecrawlService]', message);
    }
  }

  const detailedMessage = errors.join(' | ');
  return {
    pages: [],
    totalPages: 0,
    error: detailedMessage || 'Unable to scrape the provided URL. Please try again.',
  };
}

function stripMarkdownAndHtml(value) {
  return String(value || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/[#*_`~>]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function chunkWords(text, maxWords = 400, overlapWords = 50) {
  const words = String(text || '').split(/\s+/).filter(Boolean);
  if (!words.length) return [];

  const chunks = [];
  let start = 0;

  while (start < words.length) {
    const end = Math.min(start + maxWords, words.length);
    chunks.push(words.slice(start, end).join(' '));
    if (end === words.length) break;
    start = Math.max(end - overlapWords, start + 1);
  }

  return chunks;
}

function fallbackCleanAndChunkContent(pages) {
  const fallbackSections = [];

  for (const page of pages || []) {
    const metadata = page?.metadata || {};
    const metadataText = [
      page?.title,
      metadata.title,
      metadata.description,
      metadata.ogDescription,
      metadata['og:description'],
      metadata.keywords,
    ]
      .filter(Boolean)
      .join('. ');

    const pageText = stripMarkdownAndHtml(page?.content || page?.markdown || '');
    const combined = [metadataText, pageText]
      .filter(Boolean)
      .join('. ')
      .replace(/\s+/g, ' ')
      .trim();

    if (combined.length >= 120) {
      fallbackSections.push(combined);
    }
  }

  const combined = [...new Set(fallbackSections)].join('\n\n').trim();
  if (combined.length < 150) return [];

  return chunkWords(combined, 400, 50).filter((chunk) => chunk.length >= 150);
}

export function cleanAndChunkContent(pages) {
  if (!Array.isArray(pages)) return [];

  const cleanedPages = pages
    .map((page) => page?.content || page?.markdown || '')
    .map((content) => {
      const lines = content.split('\n').filter((line) => {
        const trimmed = line.trim();
        if (trimmed.length < 40) return false;
        if (trimmed.split('|').length - 1 > 5) return false;
        return !EXCLUDE_LINE_PATTERNS.some((pattern) => pattern.test(trimmed));
      });

      return lines
        .join('\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
    })
    .filter((content) => content.length >= 150);

  const combined = cleanedPages.join('\n\n');
  const strictChunks = [];

  if (combined) {
    const paragraphs = combined.split(/\n\n+/);
    let currentWords = [];

    for (const paragraph of paragraphs) {
      const paragraphWords = paragraph.split(/\s+/).filter(Boolean);
      if (paragraphWords.length === 0) continue;

      const tentative = [...currentWords, ...paragraphWords];

      if (tentative.length > 400 && currentWords.length > 0) {
        strictChunks.push(currentWords.join(' '));
        const overlap = currentWords.slice(-50);
        currentWords = [...overlap, ...paragraphWords];
      } else {
        currentWords = tentative;
      }
    }

    if (currentWords.length > 0) {
      strictChunks.push(currentWords.join(' '));
    }
  }

  const filteredStrictChunks = strictChunks.filter((chunk) => {
    const wordCount = chunk.split(/\s+/).filter(Boolean).length;
    const pipeCount = chunk.split('|').length - 1;
    return wordCount >= 30 && pipeCount <= 5;
  });

  if (filteredStrictChunks.length) return filteredStrictChunks;

  const fallbackChunks = fallbackCleanAndChunkContent(pages);
  if (fallbackChunks.length) {
    console.warn(
      `[firecrawlService] Using thin-site fallback extraction. pages=${pages.length} chunks=${fallbackChunks.length}`,
    );
  }

  return fallbackChunks;
}

export function shouldEmbedChunk(chunk) {
  const text = typeof chunk === 'string' ? chunk : String(chunk || '');
  const lower = text.toLowerCase();

  if (text.length < 150) return false;
  if (text.includes('Home | About | Services')) return false;
  if (lower.includes('we use cookies')) return false;
  if (lower.includes('all rights reserved')) return false;
  if (text.split('|').length > 5) return false;

  return true;
}
