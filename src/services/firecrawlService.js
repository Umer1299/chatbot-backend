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

function extractPages(payload) {
  const candidates = [
    payload?.data?.pages,
    payload?.pages,
    payload?.data?.data,
    payload?.data,
  ];

  const pages = candidates.find(Array.isArray) || [];

  return pages
    .map((page) => ({
      url: page?.url || page?.metadata?.sourceURL || page?.metadata?.url || '',
      content: page?.markdown || page?.content || page?.html || '',
      title: page?.metadata?.title || page?.title || '',
    }))
    .filter((page) => page.content);
}

function crawlHasFinishedWithData(payload) {
  const pages = extractPages(payload);
  if (!pages.length) return false;

  const completed = Number(payload?.completed ?? payload?.data?.completed ?? 0);
  const total = Number(payload?.total ?? payload?.data?.total ?? 0);

  if (total > 0 && completed >= total) return true;
  if (payload?.next === null || payload?.data?.next === null) return true;

  return false;
}

async function startCrawl(baseUrl, url, options) {
  const crawlUrl = `${baseUrl}/v1/crawl`;
  const response = await fetchWithTimeout(crawlUrl, {
    method: 'POST',
    headers: getFirecrawlHeaders(baseUrl, true),
    body: JSON.stringify({
      url,
      limit: options.limit || 20,
      maxDepth: options.maxDepth || 2,
      scrapeOptions: {
        formats: ['markdown'],
        excludeTags: ['script', 'style', 'nav', 'footer', 'header', 'aside', '.cookie-banner', '#cookie'],
      },
      excludePaths: options.excludePaths || DEFAULT_EXCLUDE_PATHS,
    }),
  });

  const payload = await readJsonResponse(response, `Firecrawl start crawl at ${crawlUrl}`);

  if (!response.ok) {
    throw new Error(payload?.error || payload?.message || `Failed to start crawl (${response.status})`);
  }

  return payload;
}

async function pollCrawl(baseUrl, jobId) {
  const pollUrl = `${baseUrl}/v1/crawl/${jobId}`;
  const start = Date.now();

  while (Date.now() - start < FIRECRAWL_TIMEOUT_MS) {
    const pollResp = await fetchWithTimeout(pollUrl, {
      method: 'GET',
      headers: getFirecrawlHeaders(baseUrl),
    });

    const pollPayload = await readJsonResponse(pollResp, `Firecrawl poll crawl at ${pollUrl}`);

    if (!pollResp.ok) {
      throw new Error(pollPayload?.error || pollPayload?.message || `Crawl polling failed (${pollResp.status})`);
    }

    const status = pollPayload?.status || pollPayload?.data?.status;

    if (status === 'completed' || crawlHasFinishedWithData(pollPayload)) {
      return extractPages(pollPayload);
    }

    if (status === 'failed') {
      throw new Error(pollPayload?.error || pollPayload?.data?.error || 'Firecrawl crawl failed');
    }

    await new Promise((resolve) => setTimeout(resolve, FIRECRAWL_POLL_INTERVAL_MS));
  }

  throw new Error(`Firecrawl crawl timed out after ${Math.round(FIRECRAWL_TIMEOUT_MS / 1000)} seconds`);
}

async function scrapeWithBaseUrl(baseUrl, url, options) {
  const payload = await startCrawl(baseUrl, url, options);
  const jobId = payload?.jobId || payload?.id || payload?.data?.jobId || payload?.data?.id;

  if (jobId) {
    return pollCrawl(baseUrl, jobId);
  }

  return extractPages(payload);
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
  if (!combined) return [];

  const paragraphs = combined.split(/\n\n+/);
  const chunks = [];
  let currentWords = [];

  for (const paragraph of paragraphs) {
    const paragraphWords = paragraph.split(/\s+/).filter(Boolean);
    if (paragraphWords.length === 0) continue;

    const tentative = [...currentWords, ...paragraphWords];

    if (tentative.length > 400 && currentWords.length > 0) {
      chunks.push(currentWords.join(' '));
      const overlap = currentWords.slice(-50);
      currentWords = [...overlap, ...paragraphWords];
    } else {
      currentWords = tentative;
    }
  }

  if (currentWords.length > 0) {
    chunks.push(currentWords.join(' '));
  }

  return chunks.filter((chunk) => {
    const wordCount = chunk.split(/\s+/).filter(Boolean).length;
    const pipeCount = chunk.split('|').length - 1;
    return wordCount >= 30 && pipeCount <= 5;
  });
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
