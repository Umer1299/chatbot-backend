import { assertIngestionResult, ingestionErrorPayload } from '../services/ingestionResult.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import express from 'express';
import multer from 'multer';
import { fileQueue } from '../queues/fileQueue.js';
import { markContentProcessed } from '../services/recordManager.js';
import { deleteBusinessChunks, upsertSupplementalChunks } from '../db/vectorStore.js';
import { cleanAndChunkContent, shouldEmbedChunk } from '../services/firecrawlService.js';
import pool from '../db/pool.js';
import { requireKnowledgeOwner } from '../middleware/knowledgeAuth.js';
import { redisClient } from '../services/redis.js';
import { v4 as uuidv4 } from 'uuid';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024, files: 3 } });

router.post('/', requireKnowledgeOwner, upload.array('files', 3), asyncHandler(async (req, res) => {
  const namespace = req.namespace;
  const text = req.body.text;
  const files = req.files || [];

  try {
    if (text != null && typeof text !== 'string') return res.status(400).json({ error: 'text must be a string' });
    if (text && text.trim()) {
      const bizResult = await pool.query(
        'SELECT id FROM businesses WHERE bot_id = $1',
        [namespace]
      );
      if (!bizResult.rows.length) {
        return res.status(404).json({ error: 'Business not found' });
      }
      const businessId = bizResult.rows[0].id;

      const fakePages = [{
        content: text,
        url: 'manual-upload',
        title: 'Manual text upload'
      }];
      const chunks = cleanAndChunkContent(fakePages).filter(shouldEmbedChunk);
      if (chunks.length === 0) {
        return res.status(400).json({ error: 'Text too short or low quality' });
      }

      const result = await upsertSupplementalChunks(businessId, chunks, 'owner_upload');
      assertIngestionResult(result, chunks.length);
      await markContentProcessed(text, namespace);
      if (result.inserted === 0 && result.skipped >= chunks.length) {
        return res.json({ success: true, skipped: true, reason: 'Duplicate text', chunksUpserted: 0 });
      }
      return res.json({
        success: true,
        chunksUpserted: result.inserted,
        ingestionStatus: result.status,
        message: `${result.inserted} knowledge chunks added`
      });
    }

    if (!files.length) return res.status(400).json({ error: 'No files or text provided' });

    const jobIds = [];
    for (const file of files) {
      const tempDir = os.tmpdir();
      const uniqueName = `${uuidv4()}-${path.basename(file.originalname)}`;
      const filePath = path.join(tempDir, uniqueName);
      await fs.writeFile(filePath, file.buffer);

      const jobId = uuidv4();
      try {
        // Publish queued status first: a fast worker must not have its terminal
        // status overwritten by the HTTP request after add() returns.
        await redisClient.setex(`job:${jobId}`, 86400, JSON.stringify({ status: 'queued', namespace, businessId: req.business.businessId }));
        await fileQueue.add('process-file', {
          namespace,
          businessId: req.business.businessId,
          filePath,
          originalName: file.originalname,
          mimeType: file.mimetype,
          jobId,
        });
      } catch (error) {
        await redisClient.setex(`job:${jobId}`, 86400, JSON.stringify({ status: 'failed', namespace, businessId: req.business.businessId, error: 'File queue unavailable. Please retry.' })).catch(() => {});
        await fs.unlink(filePath).catch(() => {});
        throw error;
      }
      jobIds.push(jobId);
      console.log(`File queued: ${file.originalname} for namespace ${namespace}, job ${jobId}`);
    }
    res.json({ success: true, queued: true, jobIds });
  } catch (err) {
    console.error('Upsert error:', err);
    console.error('[upsert]', req.method, req.path, err.message);
    res.status(err.status || 500).json(ingestionErrorPayload(err));
  }
}));

router.get('/job/:jobId', requireKnowledgeOwner, asyncHandler(async (req, res) => {
  const { jobId } = req.params;
  const raw = await redisClient.get(`job:${jobId}`);
  if (!raw) return res.status(404).json({ error: 'Job not found' });

  const job = JSON.parse(raw);

  if (!job.namespace) {
    return res.status(404).json({ error: 'Job not found' });
  }

  if (job.namespace !== req.namespace || (job.businessId && job.businessId !== req.business.businessId)) {
    console.warn('[upsert] Cross-namespace job access', {
      caller: req.namespace,
      jobNamespace: job.namespace,
      ip: req.ip
    });
    return res.status(403).json({ error: 'Access denied' });
  }

  res.json(job);
}));

router.delete('/namespace/:namespace', requireKnowledgeOwner, asyncHandler(async (req, res) => {
  await deleteBusinessChunks(req.business.businessId);
  res.json({ success: true });
}));

export default router;
