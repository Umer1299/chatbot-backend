import pool from '../db/pool.js';
import {
  scrapeWebsite,
  cleanAndChunkContent,
  shouldEmbedChunk,
} from '../services/firecrawlService.js';
import { upsertChunks, deleteBusinessChunks } from '../db/vectorStore.js';
import { detectIndustry } from '../agents/industryDetector.js';
import { validateWebsiteContent } from '../agents/contentValidator.js';
import { generateChatbotContent } from '../agents/contentGenerator.js';
import { suggestAgents } from '../agents/agentSelector.js';

const DEFAULT_PRIMARY_COLOR = '#111827';
const DEFAULT_STARTER_PROMPTS = [
  'What services do you offer?',
  'How much does it cost?',
  'How can I contact you?',
];

export async function addScrapeJob(businessId, url) {
  const { rows } = await pool.query(
    `INSERT INTO scrape_jobs (business_id, url, status, queued_at)
     VALUES ($1, $2, 'queued', NOW())
     RETURNING id`,
    [businessId, url],
  );

  return String(rows[0].id);
}

function parseJsonValue(value, fallback = null) {
  if (value == null) return fallback;
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    return fallback ?? value;
  }
}

function normalizeStarterPrompts(value, businessInfo = {}) {
  const parsed = parseJsonValue(value, value);
  const prompts = Array.isArray(parsed)
    ? parsed
    : typeof parsed === 'string'
      ? parsed.split('\n')
      : [];

  const normalized = prompts
    .map((item) => String(item || '').trim())
    .map((item) => item.replace(/^[-*\d.)\s]+/, '').trim())
    .filter(Boolean)
    .slice(0, 3);

  if (normalized.length) return normalized;

  const services = Array.isArray(businessInfo.primaryServices)
    ? businessInfo.primaryServices.filter(Boolean)
    : [];

  return [
    services[0] ? `Tell me about ${services[0]}` : DEFAULT_STARTER_PROMPTS[0],
    DEFAULT_STARTER_PROMPTS[1],
    businessInfo.calendlyLink ? 'How can I book a call?' : DEFAULT_STARTER_PROMPTS[2],
  ];
}

function normalizeJobRow(row) {
  if (!row) return null;
  const result = parseJsonValue(row.result, row.result) || null;
  const starterPrompts = normalizeStarterPrompts(row.starter_prompts, result || {});

  return {
    ...row,
    starter_prompts: starterPrompts,
    starterPrompts,
    result: result
      ? {
          ...result,
          starterPrompts: normalizeStarterPrompts(result.starterPrompts || starterPrompts, result),
        }
      : result,
  };
}

export async function getJobStatus(jobId) {
  const { rows } = await pool.query(
    `SELECT id, status, progress_step, progress_percent,
            pages_scraped, chunks_created, detected_industry,
            content_quality_score, missing_fields,
            auto_generated_fields, has_critical_gaps,
            welcome_message, starter_prompts,
            system_prompt_draft, result,
            error_message, queued_at, started_at, completed_at
     FROM scrape_jobs
     WHERE id = $1`,
    [jobId],
  );

  return normalizeJobRow(rows[0] || null);
}

export async function refreshScrapeJob(businessId, url) {
  await deleteBusinessChunks(businessId);
  return addScrapeJob(businessId, url);
}

async function updateJobProgress(jobId, step, percent, extras = {}) {
  try {
    const fields = ['progress_step = $2', 'progress_percent = $3'];
    const values = [jobId, step, percent];
    let index = 4;

    for (const [key, value] of Object.entries(extras)) {
      fields.push(`${key} = $${index}`);
      values.push(value);
      index += 1;
    }

    await pool.query(`UPDATE scrape_jobs SET ${fields.join(', ')} WHERE id = $1`, values);
  } catch (error) {
    console.error('SCRAPE_JOB_PROGRESS_UPDATE_ERROR:', error);
  }
}

function firstNonEmpty(...values) {
  return values.find((value) => typeof value === 'string' && value.trim())?.trim() || null;
}

function toAbsoluteUrl(value, baseUrl) {
  if (!value) return null;
  try {
    return new URL(value, baseUrl).toString();
  } catch {
    return value;
  }
}

function extractPrimaryColorFromValue(value) {
  const text = typeof value === 'string' ? value : '';
  const match = text.match(/#(?:[0-9a-fA-F]{3}){1,2}\b/);
  return match?.[0] || null;
}

function extractBrandAssets(pages = [], sourceUrl = '', existing = {}) {
  const homePage = pages.find((page) => page?.url === sourceUrl) || pages[0] || {};
  const metadata = homePage.metadata || {};

  const logoCandidate = firstNonEmpty(
    metadata.logo,
    metadata.logoUrl,
    metadata.logo_url,
    metadata['og:image'],
    metadata.ogImage,
    metadata.ogImageUrl,
    metadata['twitter:image'],
    metadata.twitterImage,
    metadata.favicon,
    metadata['msapplication-TileImage'],
  );

  const colorCandidate = firstNonEmpty(
    metadata['theme-color'],
    metadata.themeColor,
    metadata['msapplication-TileColor'],
    metadata.msapplicationTileColor,
    extractPrimaryColorFromValue(metadata.description),
    extractPrimaryColorFromValue(metadata.ogDescription),
    existing.primary_color,
    DEFAULT_PRIMARY_COLOR,
  );

  return {
    logoUrl: toAbsoluteUrl(logoCandidate, homePage.url || sourceUrl),
    primaryColor: colorCandidate,
  };
}

function getScrapedTextStats(pages = []) {
  const rawCharacters = pages.reduce(
    (sum, page) => sum + String(page?.content || page?.markdown || '').trim().length,
    0,
  );

  const titles = pages
    .map((page) => page?.title || page?.metadata?.title)
    .filter(Boolean)
    .slice(0, 3);

  return { rawCharacters, titles };
}

async function processScrapeJob(job) {
  try {
    await updateJobProgress(job.id, 'Scraping website', 10, {
      status: 'scraping',
      started_at: new Date(),
    });

    const result = await scrapeWebsite(job.url);
    if (result.error) {
      throw new Error(`Scraping failed: ${result.error}`);
    }
    if (!result.pages?.length) {
      throw new Error('No pages found at this URL');
    }

    await updateJobProgress(job.id, 'Processing content', 25, {
      pages_scraped: result.pages.length,
      status: 'processing',
    });

    const chunks = cleanAndChunkContent(result.pages);
    const filtered = chunks.filter(shouldEmbedChunk);

    if (!filtered.length) {
      const stats = getScrapedTextStats(result.pages);
      throw new Error(
        `Website was scraped (${result.pages.length} pages), but no embed-ready business content was found after cleaning. Raw scraped characters: ${stats.rawCharacters}. This usually means the site is image-heavy, has mostly navigation/cookie/footer text, or very short page copy.`,
      );
    }

    await updateJobProgress(job.id, 'Generating embeddings', 40, {
      chunks_created: filtered.length,
      status: 'embedding',
    });

    await upsertChunks(job.business_id, filtered, 'website');

    await updateJobProgress(job.id, 'Analysing business', 65, {
      status: 'analyzing',
    });

    const combinedText = filtered.join(' ').substring(0, 6000);
    const analysisResult = await detectIndustry(combinedText);

    await pool.query(
      `UPDATE businesses
       SET industry = CASE WHEN industry = 'other' THEN $1 ELSE industry END,
           updated_at = NOW()
       WHERE id = $2`,
      [analysisResult.industry, job.business_id],
    );

    await updateJobProgress(job.id, 'Checking content quality', 75, {
      status: 'validating',
    });

    const validation = await validateWebsiteContent(
      analysisResult.industry,
      combinedText,
      analysisResult,
    );

    const suggestedAgents = suggestAgents(
      analysisResult.industry,
      analysisResult,
      combinedText,
    );
    const defaultAgentIds = suggestedAgents?.suggestedAgentIds || [];

    await updateJobProgress(job.id, 'Generating chatbot content', 85, {
      status: 'generating',
    });

    const { rows: businessRows } = await pool.query(
      `SELECT availability_slots, owner_phone, calendly_link,
              business_name, primary_color, logo_url
       FROM businesses
       WHERE id = $1`,
      [job.business_id],
    );
    const businessRow = businessRows[0] || {};
    const brandAssets = extractBrandAssets(result.pages, job.url, businessRow);

    const businessInfo = {
      industry: analysisResult.industry,
      businessName: analysisResult.businessName || businessRow.business_name,
      primaryServices: analysisResult.primaryServices,
      location: analysisResult.location,
      ownerPhone: businessRow.owner_phone,
      calendlyLink: businessRow.calendly_link,
    };

    const generatedContent = await generateChatbotContent(
      businessInfo,
      defaultAgentIds,
      businessRow.availability_slots,
      validation,
    );
    const starterPrompts = normalizeStarterPrompts(generatedContent.starterPrompts, businessInfo);

    await pool.query(
      `UPDATE businesses
       SET logo_url = COALESCE($2, logo_url),
           primary_color = COALESCE($3, primary_color),
           updated_at = NOW()
       WHERE id = $1`,
      [job.business_id, brandAssets.logoUrl, brandAssets.primaryColor],
    );

    await pool.query(
      `UPDATE scrape_jobs
       SET status = 'complete',
           progress_step = 'Complete',
           progress_percent = 100,
           detected_industry = $2,
           content_quality_score = $3,
           missing_fields = $4,
           auto_generated_fields = $5,
           has_critical_gaps = $6,
           welcome_message = $7,
           starter_prompts = $8::jsonb,
           system_prompt_draft = $9,
           result = $10::jsonb,
           completed_at = NOW()
       WHERE id = $1`,
      [
        job.id,
        analysisResult.industry,
        validation.score,
        JSON.stringify(validation.missing),
        JSON.stringify(validation.autoGenerated),
        validation.hasCriticalGaps,
        generatedContent.welcomeMessage,
        JSON.stringify(starterPrompts),
        generatedContent.systemPrompt,
        JSON.stringify({
          ...analysisResult,
          suggestedAgentIds: defaultAgentIds,
          contentQuality: validation,
          logoUrl: brandAssets.logoUrl,
          primaryColor: brandAssets.primaryColor,
          starterPrompts,
        }),
      ],
    );

    await pool.query(
      `INSERT INTO bot_configs
        (business_id, detected_industry,
         detected_services, detected_location,
         detection_confidence, content_quality_score,
         missing_fields, auto_generated_fields,
         selected_agents, system_prompt,
         welcome_message, starter_prompts,
         logo_url, primary_color, is_draft)
       VALUES ($1, $2, $3::jsonb, $4, $5, $6, $7::jsonb, $8::jsonb, $9, $10, $11, $12::jsonb, $13, $14, true)
       ON CONFLICT (business_id)
       DO UPDATE SET
         detected_industry = EXCLUDED.detected_industry,
         system_prompt = EXCLUDED.system_prompt,
         welcome_message = EXCLUDED.welcome_message,
         starter_prompts = EXCLUDED.starter_prompts,
         selected_agents = EXCLUDED.selected_agents,
         logo_url = COALESCE(EXCLUDED.logo_url, bot_configs.logo_url),
         primary_color = COALESCE(EXCLUDED.primary_color, bot_configs.primary_color),
         is_draft = true,
         updated_at = NOW()`,
      [
        job.business_id,
        analysisResult.industry,
        JSON.stringify(analysisResult.primaryServices || []),
        analysisResult.location || null,
        analysisResult.confidence || null,
        validation.score,
        JSON.stringify(validation.missing),
        JSON.stringify(validation.autoGenerated),
        defaultAgentIds,
        generatedContent.systemPrompt,
        generatedContent.welcomeMessage,
        JSON.stringify(starterPrompts),
        brandAssets.logoUrl,
        brandAssets.primaryColor,
      ],
    );

    console.log(`Job complete for business ${job.business_id}`);
  } catch (error) {
    await pool.query(
      `UPDATE scrape_jobs
       SET status = 'failed',
           error_message = $2,
           retry_count = retry_count + 1
       WHERE id = $1`,
      [job.id, error.message],
    );
  }
}

export function startScrapeWorker() {
  console.log('Scrape worker started — polling every 5 seconds');

  setInterval(async () => {
    try {
      const { rows } = await pool.query(
        `UPDATE scrape_jobs
         SET status = 'scraping', started_at = NOW()
         WHERE id = (
           SELECT id
           FROM scrape_jobs
           WHERE status = 'queued'
           ORDER BY queued_at ASC
           LIMIT 1
           FOR UPDATE SKIP LOCKED
         )
         RETURNING *`,
      );

      if (rows[0]) {
        await processScrapeJob(rows[0]);
      }
    } catch (error) {
      console.error('SCRAPE_WORKER_ERROR:', error);
    }
  }, 5000);
}
