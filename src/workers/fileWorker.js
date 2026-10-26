import { assertInfraStaging } from '../config/infraStaging.js';

if (assertInfraStaging()) throw new Error('File worker is disabled in infrastructure-only staging');
const { assertIngestionResult } = await import('../services/ingestionResult.js');
const { Worker } = await import('bullmq');
const { connection } = await import('../queues/connection.js');
const { loadFile } = await import('../services/fileLoader.js');
const { markContentProcessed } = await import('../services/recordManager.js');
const { upsertSupplementalChunks } = await import('../db/vectorStore.js');
const { cleanAndChunkContent, shouldEmbedChunk } = await import('../services/firecrawlService.js');
const { default: pool } = await import('../db/pool.js');
const { redisClient } = await import('../services/redis.js');
const { default: fs } = await import('fs/promises');

const CONCURRENCY = parseInt(process.env.WORKER_CONCURRENCY || '2');

const worker = new Worker('file-processing', async (job) => {
  const { namespace, businessId: expectedBusinessId, filePath, originalName, mimeType, jobId } = job.data;
  console.log(`Processing file ${originalName} for namespace ${namespace}, job ${jobId}`);

  try {
    const bizResult = await pool.query(
      'SELECT id FROM businesses WHERE bot_id = $1',
      [namespace]
    );
    if (!bizResult.rows.length) {
      throw new Error('Business not found: ' + namespace);
    }
    const businessId = bizResult.rows[0].id;
    if (expectedBusinessId && businessId !== expectedBusinessId) throw new Error('Invalid job business scope');

    await job.updateProgress(10);
    const fileBuffer = await fs.readFile(filePath);

    await job.updateProgress(30);
    const docs = await loadFile(fileBuffer, originalName, mimeType);

    await job.updateProgress(50);
    // Redis document markers are hints only: deleted knowledge must be uploadable
    // again. The ingestion helper checks current business/source content in SQL.
    const newDocs = docs;

    if (newDocs.length === 0) {
      await redisClient.setex(`job:${jobId}`, 86400, JSON.stringify({ status: 'completed', skipped: true, namespace, businessId: expectedBusinessId }));
      await fs.unlink(filePath).catch(() => {});
      return { skipped: true, message: 'All duplicates' };
    }

    await job.updateProgress(70);
    const extractedText = newDocs.map((doc) => doc.pageContent).join('\n\n');

    await job.updateProgress(90);

    const fakePages = [{
      content: extractedText,
      url: 'file-upload:' + (job.data.filename || 'unknown'),
      title: job.data.filename || 'Uploaded file'
    }];
    const chunks = cleanAndChunkContent(fakePages).filter(shouldEmbedChunk);
    const result = await upsertSupplementalChunks(businessId, chunks, 'owner_upload');

    assertIngestionResult(result, chunks.length);
    for (const doc of newDocs) await markContentProcessed(doc.pageContent, namespace);
    await job.updateProgress(100);
    await redisClient.setex(`job:${jobId}`, 86400, JSON.stringify({
      status: 'completed', chunksAdded: result.inserted, namespace, businessId, ...((chunks.length === 0 || (result.inserted === 0 && result.skipped >= chunks.length)) ? { skipped: true } : {})
    }));
    await fs.unlink(filePath).catch(() => {});
    console.log(`Job ${jobId} completed, chunks: ${result.inserted}`);

    return { success: true, chunksUpserted: result.inserted };
  } catch (err) {
    console.error(`File worker error: ${err.message}`);
    const finalAttempt = (job.attemptsMade || 0) + 1 >= (job.opts?.attempts || 1);
    await redisClient.setex(`job:${jobId}`, 86400, JSON.stringify({ status: finalAttempt ? 'failed' : 'queued', error: 'File processing failed. Please try again.', namespace, businessId: expectedBusinessId, ...(err.result ? { ingestion: err.result } : {}) })).catch(() => {});
    // Keep source bytes while BullMQ can retry; remove them on the final attempt.
    if (finalAttempt) {
      await fs.unlink(filePath).catch(() => {});
    }
    throw err;
  }
}, { connection, concurrency: CONCURRENCY });

worker.on('completed', (job) => console.log(`Job ${job.id} completed`));
worker.on('failed', (job, err) => console.error(`Job ${job?.id} failed: ${err.message}`));

console.log(`Worker started with concurrency ${CONCURRENCY}`);
export { worker };
