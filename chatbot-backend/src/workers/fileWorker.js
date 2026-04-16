import { Worker } from 'bullmq';
import { connection } from '../queues/connection.js';
import { loadFile } from '../services/fileLoader.js';
import { isDuplicateContent } from '../services/recordManager.js';
import { RecursiveCharacterTextSplitter } from 'langchain/text_splitter';
import { getVectorStore } from '../services/pinecone.js';
import { redisClient } from '../services/redis.js';
import fs from 'fs/promises';

const CONCURRENCY = parseInt(process.env.WORKER_CONCURRENCY || '2');

const worker = new Worker('file-processing', async (job) => {
  const { namespace, filePath, originalName, mimeType, jobId } = job.data;
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
      await redisClient.setex(`job:${jobId}`, 86400, JSON.stringify({ status: 'completed', skipped: true }));
      await fs.unlink(filePath).catch(() => {});
      return { skipped: true, message: 'All duplicates' };
    }

    await job.updateProgress(70);
    const splitter = new RecursiveCharacterTextSplitter({ chunkSize: 1000, chunkOverlap: 200 });
    const chunks = await splitter.splitDocuments(newDocs);

    await job.updateProgress(90);
    const vectorStore = await getVectorStore(namespace);
    await vectorStore.addDocuments(chunks);

    await job.updateProgress(100);
    await redisClient.setex(`job:${jobId}`, 86400, JSON.stringify({ status: 'completed', chunksUpserted: chunks.length }));
    await fs.unlink(filePath).catch(() => {});
    console.log(`Job ${jobId} completed, chunks: ${chunks.length}`);

    return { success: true, chunksUpserted: chunks.length };
  } catch (err) {
    console.error(`File worker error: ${err.message}`);
    await redisClient.setex(`job:${jobId}`, 86400, JSON.stringify({ status: 'failed', error: err.message }));
    await fs.unlink(filePath).catch(() => {});
    throw err;
  }
}, { connection, concurrency: CONCURRENCY });

worker.on('completed', (job) => console.log(`Job ${job.id} completed`));
worker.on('failed', (job, err) => console.error(`Job ${job?.id} failed: ${err.message}`));

console.log(`Worker started with concurrency ${CONCURRENCY}`);
export { worker };