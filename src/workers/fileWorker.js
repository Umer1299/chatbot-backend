import { Worker } from 'bullmq';
import { connection } from '../queues/connection.js';
import { loadFile } from '../services/fileLoader.js';
import { isDuplicateContent } from '../services/recordManager.js';
import { upsertSupplementalChunks } from '../db/vectorStore.js';
import { cleanAndChunkContent, shouldEmbedChunk } from '../services/firecrawlService.js';
import pool from '../db/pool.js';
import { redisClient } from '../services/redis.js';
import fs from 'fs/promises';

const CONCURRENCY = parseInt(process.env.WORKER_CONCURRENCY || '2');

async function setJobStatus(jobId, payload) {
  await redisClient.setex(`job:${jobId}`, 86400, JSON.stringify(payload));
}

const worker = new Worker('file-processing', async (job) => {
  const { namespace, filePath, originalName, mimeType, jobId, metadata = {} } = job.data;
  console.log(`Processing file ${originalName} for namespace ${namespace}, job ${jobId}`);

  try {
    await job.updateProgress(10);
    const fileBuffer = await fs.readFile(filePath);

    await job.updateProgress(30);
    const docs = await loadFile(fileBuffer, originalName, mimeType);

    await job.updateProgress(50);
    const newDocs = [];
    for (const doc of docs) {
      const isDup = await isDuplicateContent(doc.pageContent, namespace);
      if (!isDup) newDocs.push(doc);
    }

    if (newDocs.length === 0) {
      await setJobStatus(jobId, { status: 'completed', skipped: true, namespace });
      await fs.unlink(filePath).catch(() => {});
      return { skipped: true, message: 'All duplicates' };
    }

    await job.updateProgress(70);
    const extractedText = newDocs.map((doc) => doc.pageContent).join('\n\n');

    await job.updateProgress(90);
    const bizResult = await pool.query(
      'SELECT id FROM businesses WHERE bot_id = $1',
      [namespace]
    );
    if (!bizResult.rows.length) {
      throw new Error('Business not found: ' + namespace);
    }
    const businessId = bizResult.rows[0].id;

    const fakePages = [{
      content: extractedText,
      url: 'file-upload:' + (originalName || 'unknown'),
      title: originalName || 'Uploaded file'
    }];
    const chunks = cleanAndChunkContent(fakePages).filter(shouldEmbedChunk);
    const result = await upsertSupplementalChunks(businessId, chunks, 'owner_upload', {
      sourceUrl: `file-upload:${originalName || 'unknown'}`,
      metadata,
    });

    await job.updateProgress(100);
    await setJobStatus(jobId, {
      status: 'completed',
      chunksAdded: result.inserted,
      namespace
    });
    await fs.unlink(filePath).catch(() => {});
    console.log(`Job ${jobId} completed, chunks: ${result.inserted}`);

    return { success: true, chunksUpserted: result.inserted };
  } catch (err) {
    console.error(`File worker error: ${err.message}`);
    await setJobStatus(jobId, {
      status: 'failed',
      error: 'File processing failed. Please try again.',
      namespace
    });
    await fs.unlink(filePath).catch(() => {});
    throw err;
  }
}, { connection, concurrency: CONCURRENCY });

worker.on('completed', (job) => console.log(`Job ${job.id} completed`));
worker.on('failed', (job, err) => console.error(`Job ${job?.id} failed: ${err.message}`));

console.log(`Worker started with concurrency ${CONCURRENCY}`);
export { worker };
