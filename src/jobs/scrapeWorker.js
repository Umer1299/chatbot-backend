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

function safePrimaryColorFromContent(text = '') {
  const match = text.match(/#(?:[0-9a-fA-F]{3}){1,2}\b/);
  return match ? match[0] : '#1F6FEB';
}

function extractBusinessNameFromPages(pages = [], fallback = '') {
  const title = pages.find((p) => p?.title)?.title || '';
  const candidate = title.split('|')[0].split('-')[0].trim();
  return candidate || fallback || 'Your Business';
}

function extractContactInfo(text = '') {
  const email = text.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i)?.[0] || null;
  const phone = text.match(/(?:\+?1[\s.-]?)?(?:\(?\d{3}\)?[\s.-]?){2}\d{4}/)?.[0] || null;
  return { email, phone };
}


function extractBrandData(pages = [], baseUrl = '') {
  const allText = pages.map((p) => `${p.title || ''}
${p.content || ''}`).join('\n');
  const firstPage = pages[0] || {};
  const titleCandidate = (firstPage.title || '').split('|')[0].split('-')[0].trim();
  const orgMatch = allText.match(/organization\"?\s*:\s*\"?([^\"\n]+)/i);
  const ogSiteName = allText.match(/og:site_name[^\n:]*[:\s]+([^\n]+)/i);
  const headerMatch = allText.match(/^#\s+(.{2,80})/m);
  const businessName = titleCandidate || orgMatch?.[1]?.trim() || ogSiteName?.[1]?.trim() || headerMatch?.[1]?.trim() || 'Your Business';

  const imageMatches = [...allText.matchAll(/!\[[^\]]*\]\(([^)]+)\)/g)].map((m) => m[1]);
  const logoUrl = imageMatches.find((u) => /logo|brand|header/i.test(u)) || imageMatches[0] || null;
  const normalizedBase = baseUrl.replace(/\/+$/, '');
  const faviconUrl = `${normalizedBase}/favicon.ico`;

  const colorMatches = [...new Set((allText.match(/#(?:[0-9a-fA-F]{3}){1,2}\b/g) || []).map((c) => c.toUpperCase()))];
  const primaryColor = colorMatches[0] || '#1F6FEB';
  const secondaryColor = colorMatches[1] || '#111827';

  const fontMatches = [...new Set((allText.match(/font-family\s*:\s*([^;\n]+)/gi) || []).map((f) => f.split(':')[1].trim().replace(/["']/g, '')))].slice(0, 5);

  return {
    businessName,
    logoUrl,
    faviconUrl,
    primaryColor,
    secondaryColor,
    fonts: fontMatches,
  };
}

export async function addScrapeJob(businessId, url, options = {}) {
  const isRefresh = Boolean(options.isRefresh);

  const { rows } = await pool.query(
    `INSERT INTO scrape_jobs (business_id, url, status, queued_at)
     VALUES ($1, $2, 'queued', NOW())
     RETURNING id`,
    [businessId, url],
  );

  if (isRefresh) {
    await pool.query(
      `UPDATE scrape_jobs
       SET is_refresh = TRUE
       WHERE id = $1
         AND EXISTS (
           SELECT 1
           FROM information_schema.columns
           WHERE table_name = 'scrape_jobs'
             AND column_name = 'is_refresh'
         )`,
      [rows[0].id],
    );
  }

  return String(rows[0].id);
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

  return rows[0] || null;
}

export async function refreshScrapeJob(businessId, url) {
  await deleteBusinessChunks(businessId);
  return addScrapeJob(businessId, url, { isRefresh: true });
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

async function processScrapeJob(job) {
  const traceJobId = `job-${job.id}`;
  try {
    console.log(`[scrape:${traceJobId}] Starting scrape job`, {
      businessId: job.business_id,
      url: job.url,
      isRefresh: Boolean(job.is_refresh),
    });
    await updateJobProgress(job.id, 'Scraping website', 10, {
      status: 'scraping',
      started_at: new Date(),
    });

    const result = await scrapeWebsite(job.url, {
      jobId: traceJobId,
      timeoutMs: 300000,
      maxPages: 10,
      maxDepth: 2,
      crawlTimeout: 300000,
    });
    console.log(`[scrape:${traceJobId}] Scrape result received`, {
      pages: result.pages?.length || 0,
      totalPages: result.totalPages || 0,
      error: result.error || null,
    });
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
    console.log(`[scrape:${traceJobId}] Chunking complete`, {
      rawChunks: chunks.length,
      filteredChunks: filtered.length,
    });

    if (!filtered.length) {
      throw new Error('Could not extract usable content from this website');
    }

    await updateJobProgress(job.id, 'Generating embeddings', 40, {
      chunks_created: filtered.length,
      status: 'embedding',
    });

    console.log(`[scrape:${traceJobId}] Embedding upsert started`, { chunkCount: filtered.length });
    await upsertChunks(job.business_id, filtered, 'website');
    console.log(`[scrape:${traceJobId}] Embedding upsert completed`);

    await updateJobProgress(job.id, 'Analysing business', 65, {
      status: 'analyzing',
    });

    const combinedText = filtered.join(' ');
    const modelInputText = combinedText.substring(0, 7000);
    const analysisResult = await detectIndustry(modelInputText);
    console.log(`[scrape:${traceJobId}] Industry detection completed`, { industry: analysisResult.industry });

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
      modelInputText,
      analysisResult,
    );
    console.log(`[scrape:${traceJobId}] Content validation completed`, {
      score: validation.score,
      hasCriticalGaps: validation.hasCriticalGaps,
    });

    const suggestedAgents = suggestAgents(
      analysisResult.industry,
      analysisResult,
      modelInputText,
    );
    const defaultAgentIds = suggestedAgents?.suggestedAgentIds || [];

    await updateJobProgress(job.id, 'Generating chatbot content', 85, {
      status: 'generating',
    });

    const { rows: businessRows } = await pool.query(
      `SELECT availability_slots, owner_phone, calendly_link,
              business_name, primary_color
       FROM businesses
       WHERE id = $1`,
      [job.business_id],
    );
    const businessRow = businessRows[0] || {};

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
    console.log(`[scrape:${traceJobId}] Chatbot content generation completed`);
    const contactInfo = extractContactInfo(combinedText);
    const extractedBusinessName = extractBusinessNameFromPages(result.pages, businessInfo.businessName);
    const brandExtracted = extractBrandData(result.pages, job.url);
    const logoUrl =
      result.pages.find((p) => /logo/i.test(p.url || ''))?.url ||
      `${job.url.replace(/\/+$/, '')}/favicon.ico`;
    const primaryColor = safePrimaryColorFromContent(combinedText);
    const missingInfo = [...(validation?.missing?.critical || []), ...(validation?.missing?.important || [])];
    const enrichedResult = {
      ...analysisResult,
      businessName: extractedBusinessName,
      services: analysisResult.primaryServices || [],
      targetCustomers: analysisResult.targetCustomers || [],
      businessTone: analysisResult.tone || 'professional and helpful',
      businessSummary: analysisResult.summary || `${extractedBusinessName} provides ${(analysisResult.primaryServices || []).join(', ') || 'services'}.`,
      suggestedChatbotPurpose: `Convert visitors into qualified ${analysisResult.industry || 'business'} leads.`,
      websiteGaps: missingInfo,
      suggestedAgents: defaultAgentIds,
      systemPromptDraft: generatedContent.systemPrompt,
      welcomeMessage: generatedContent.welcomeMessage,
      starterPrompts: generatedContent.starterPrompts,
      brand: {
        logo_url: brandExtracted.logoUrl || logoUrl,
        favicon_url: brandExtracted.faviconUrl,
        primary_color: brandExtracted.primaryColor || primaryColor,
        secondary_color: brandExtracted.secondaryColor,
        fonts: brandExtracted.fonts,
      },
      contactInfo,
    };

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
           starter_prompts = $8,
           system_prompt_draft = $9,
           result = $10,
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
        JSON.stringify(generatedContent.starterPrompts),
        generatedContent.systemPrompt,
        JSON.stringify(enrichedResult),
      ],
    );

    await pool.query(
      `INSERT INTO bot_configs
        (business_id, detected_industry,
         detected_services, detected_location,
         detection_confidence, content_quality_score,
         missing_fields, auto_generated_fields,
         selected_agents, system_prompt,
         welcome_message, starter_prompts, is_draft)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, true)
       ON CONFLICT (business_id)
       DO UPDATE SET
         detected_industry = EXCLUDED.detected_industry,
         system_prompt = EXCLUDED.system_prompt,
         welcome_message = EXCLUDED.welcome_message,
         starter_prompts = EXCLUDED.starter_prompts,
         selected_agents = EXCLUDED.selected_agents,
         is_draft = true,
         brand_status = CASE WHEN $13 = true THEN 'pending' ELSE bot_configs.brand_status END,
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
        JSON.stringify(generatedContent.starterPrompts),
        Boolean(job.is_refresh),
      ],
    );

    console.log(`[scrape:${traceJobId}] Job complete for business ${job.business_id}`);
  } catch (error) {
    console.error(`[scrape:${traceJobId}] Job failed`, error);
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
      console.error('SCRAPE_WORKER_LOOP_ERROR:', error);
    }
  }, 5000);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  startScrapeWorker();
}
