
const EXCLUDE_LINE_PATTERNS = [
  /we use cookies/i,
  /all rights reserved/i,
  /privacy policy/i,
  /subscribe to our newsletter/i,
  /follow us on/i,
  /copyright \d{4}/i,
  /terms (of service|and conditions)/i,
];

export async function scrapeWebsite(url, options = {}) {
  const apiKey = process.env.FIRECRAWL_API_KEY;

  if (!apiKey) {
    return { pages: [], totalPages: 0, error: 'Missing FIRECRAWL_API_KEY' };
  }

  try {
    const baseUrl = (
      process.env.FIRECRAWL_BASE_URL?.trim()
      || process.env.FIRECRAWL_API_URL?.trim()
      || process.env.GCP_VM_URL?.trim()
      || 'http://34.138.71.42'
    ).replace(/\/+$/, '');
    const crawlUrl = `${baseUrl}/v1/crawl`;

    const response = await fetch(crawlUrl, {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        url,
        limit: options.limit || 20,
        scrapeOptions: {
          formats: ['markdown'],
        },
      }),
    });

    const payload = await parseJsonResponse(response);
    if (!response.ok) {
      throw new Error(payload?.error || payload?.message || 'Failed to start crawl');
    }

    let pages = [];
    const jobId = payload?.jobId || payload?.id || payload?.data?.jobId;

    if (jobId) {
      const pollUrl = `${baseUrl}/v1/crawl/${jobId}`;
      const start = Date.now();

      while (Date.now() - start < 120000) {
        const pollResp = await fetch(pollUrl, {
          headers: { 'x-api-key': apiKey, 'Content-Type': 'application/json' },
        });

        const pollPayload = await parseJsonResponse(pollResp);
        if (!pollResp.ok) {
          throw new Error(pollPayload?.error || pollPayload?.message || 'Crawl polling failed');
        }

        const status = (
          pollPayload?.status
          || pollPayload?.data?.status
          || pollPayload?.state
          || pollPayload?.data?.state
          || ''
        ).toLowerCase();
        if (['completed', 'done', 'success'].includes(status)) {
          pages = pollPayload?.data?.pages || pollPayload?.pages || pollPayload?.data || [];
          break;
        }

        if (['failed', 'error', 'cancelled', 'canceled'].includes(status)) {
          throw new Error(
            pollPayload?.error
            || pollPayload?.message
            || pollPayload?.data?.error
            || pollPayload?.data?.message
            || 'Firecrawl crawl failed',
          );
        }

        await new Promise((resolve) => setTimeout(resolve, 3000));
      }

      if (!pages.length) {
        throw new Error('Firecrawl crawl timed out after 120 seconds');
      }

      console.log(`Scraped ${pages.length} pages from ${url}`);
    } else {
      pages = payload?.data?.pages || payload?.pages || payload?.data || [];
    }

    const normalizedPages = (Array.isArray(pages) ? pages : [])
      .map((page) => ({
        url: page?.url || '',
        content: page?.markdown || page?.content || '',
        title: page?.metadata?.title || page?.title || '',
      }))
      .filter((page) => page.content);

    return {
      pages: normalizedPages,
      totalPages: normalizedPages.length,
      error: null,
    };
  } catch (error) {
    console.error('[firecrawlService]', error.message);
    return { pages: [], totalPages: 0, error: `Unable to scrape the provided URL. ${error.message}` };
  }
}

async function parseJsonResponse(response) {
  const rawBody = await response.text();

  try {
    return JSON.parse(rawBody);
  } catch {
    const compactBody = rawBody.replace(/\s+/g, ' ').trim().slice(0, 200);
    throw new Error(
      `Firecrawl returned a non-JSON response (status ${response.status} ${response.statusText}): ${compactBody || '<empty body>'}`,
    );
  }
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
