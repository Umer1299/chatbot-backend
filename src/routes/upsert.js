import express from 'express';
import multer from 'multer';
import { fileQueue } from '../queues/fileQueue.js';
import { isDuplicateContent } from '../services/recordManager.js';
import { upsertSupplementalChunks } from '../db/vectorStore.js';
import { cleanAndChunkContent, shouldEmbedChunk } from '../services/firecrawlService.js';
import pool from '../db/pool.js';
import { tokenAuth } from '../middleware/tokenAuth.js';
import { domainRestriction } from '../middleware/domainRestriction.js';
import { redisClient } from '../services/redis.js';
import { v4 as uuidv4 } from 'uuid';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024, files: 3 } });

router.post('/', tokenAuth, domainRestriction, upload.array('files', 3), async (req, res) => {
  const namespace = req.namespace;
  const text = req.body.text;
  const files = req.files || [];

  try {
    if (text && text.trim()) {
      const isDup = await isDuplicateContent(text, namespace);
      if (isDup) return res.json({ success: true, skipped: true, reason: 'Duplicate text' });

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
      return res.json({
        success: true,
        chunksUpserted: result.inserted,
        message: `${result.inserted} knowledge chunks added`
      });
    }

    if (!files.length) return res.status(400).json({ error: 'No files or text provided' });

    const jobIds = [];
    for (const file of files) {
      const tempDir = os.tmpdir();
      const uniqueName = `${uuidv4()}-${file.originalname}`;
      const filePath = path.join(tempDir, uniqueName);
      await fs.writeFile(filePath, file.buffer);

      const jobId = uuidv4();
      await fileQueue.add('process-file', {
        namespace,
        filePath,
        originalName: file.originalname,
        mimeType: file.mimetype,
        jobId,
      });
      jobIds.push(jobId);
      await redisClient.setex(`job:${jobId}`, 86400, JSON.stringify({ status: 'queued', namespace }));
      console.log(`File queued: ${file.originalname} for namespace ${namespace}, job ${jobId}`);
    }
    res.json({ success: true, queued: true, jobIds });
  } catch (err) {
    console.error('Upsert error:', err);
    console.error('[upsert]', req.method, req.path, err.message);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

router.get('/job/:jobId', tokenAuth, async (req, res) => {
  const { jobId } = req.params;
  const raw = await redisClient.get(`job:${jobId}`);
  if (!raw) return res.status(404).json({ error: 'Job not found' });

  const job = JSON.parse(raw);

  if (!job.namespace) {
    return res.status(404).json({ error: 'Job not found' });
  }

  if (job.namespace !== req.namespace) {
    console.warn('[upsert] Cross-namespace job access', {
      caller: req.namespace,
      jobNamespace: job.namespace,
      ip: req.ip
    });
    return res.status(403).json({ error: 'Access denied' });
  }

  res.json(job);
});

router.delete('/namespace/:namespace', tokenAuth, async (req, res) => {
  const { namespace } = req.params;
  const { client } = await initPinecone();
  const index = client.Index(process.env.PINECONE_INDEX);
  await index.namespace(namespace).deleteAll();
  res.json({ success: true });
});

export default router;