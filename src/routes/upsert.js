import express from 'express';
import multer from 'multer';
import { fileQueue } from '../queues/fileQueue.js';
import { isDuplicateContent } from '../services/recordManager.js';
import { upsertSupplementalChunks, deleteBusinessChunks, deleteBusinessChunksByFilter } from '../db/vectorStore.js';
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

function parseMetadata(rawMetadata) {
  if (!rawMetadata) return {};
  if (typeof rawMetadata === 'object') return rawMetadata;

  try {
    return JSON.parse(rawMetadata);
  } catch {
    return {};
  }
}

function normalizeFileId(value) {
  if (Array.isArray(value)) return normalizeFileId(value[0]);
  if (value === null || value === undefined) return '';
  return String(value).trim();
}

function getFileIdFromBody(body, index = 0) {
  const metadata = parseMetadata(body?.metadata);
  const indexedMetadata = Array.isArray(metadata) ? metadata[index] : metadata;
  const metadataFileId = indexedMetadata?.file_id || indexedMetadata?.fileId;
  const bodyFileId = body?.file_id || body?.fileId;

  if (Array.isArray(metadataFileId)) return normalizeFileId(metadataFileId[index]);
  if (Array.isArray(bodyFileId)) return normalizeFileId(bodyFileId[index]);

  return normalizeFileId(metadataFileId || bodyFileId);
}

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

      const fileId = getFileIdFromBody(req.body);
      const result = await upsertSupplementalChunks(businessId, chunks, 'owner_upload', {
        sourceUrl: 'manual-upload',
        fileId: fileId || null,
      });
      return res.json({
        success: true,
        chunksUpserted: result.inserted,
        message: `${result.inserted} knowledge chunks added`
      });
    }

    if (!files.length) return res.status(400).json({ error: 'No files or text provided' });

    const jobIds = [];
    for (const [index, file] of files.entries()) {
      const tempDir = os.tmpdir();
      const uniqueName = `${uuidv4()}-${file.originalname}`;
      const filePath = path.join(tempDir, uniqueName);
      await fs.writeFile(filePath, file.buffer);

      const jobId = uuidv4();
      const fileId = getFileIdFromBody(req.body, index);
      await fileQueue.add('process-file', {
        namespace,
        filePath,
        originalName: file.originalname,
        mimeType: file.mimetype,
        jobId,
        fileId: fileId || null,
      });
      jobIds.push(jobId);
      await redisClient.setex(`job:${jobId}`, 86400, JSON.stringify({ status: 'queued', namespace, fileId: fileId || null }));
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

router.delete('/chunks', tokenAuth, async (req, res) => {
  const sourceType = req.query.sourceType || req.body?.sourceType;
  const sourceUrl = req.query.sourceUrl || req.body?.sourceUrl;
  const contentHash = req.query.contentHash || req.body?.contentHash;
  const metadata = parseMetadata(req.query.metadata || req.body?.metadata);
  const metadataFileId = metadata?.file_id || metadata?.fileId;
  const fileId = req.query.file_id || req.query.fileId || req.body?.file_id || req.body?.fileId || metadataFileId;

  const filters = {
    sourceType: typeof sourceType === 'string' ? sourceType.trim() : '',
    sourceUrl: typeof sourceUrl === 'string' ? sourceUrl.trim() : '',
    contentHash: typeof contentHash === 'string' ? contentHash.trim() : '',
    fileId: normalizeFileId(fileId),
  };

  if (!filters.sourceType && !filters.sourceUrl && !filters.contentHash && !filters.fileId) {
    return res.status(400).json({
      error: 'At least one delete filter is required: sourceType, sourceUrl, contentHash, or file_id',
    });
  }

  try {
    const deleted = await deleteBusinessChunksByFilter(req.businessId, filters, { namespace: req.namespace });

    return res.json({
      success: true,
      deletedChunks: deleted,
      filters: {
        ...(filters.sourceType ? { sourceType: filters.sourceType } : {}),
        ...(filters.sourceUrl ? { sourceUrl: filters.sourceUrl } : {}),
        ...(filters.contentHash ? { contentHash: filters.contentHash } : {}),
        ...(filters.fileId ? { file_id: filters.fileId } : {}),
      },
    });
  } catch (err) {
    console.error('[upsert]', req.method, req.path, err.message);
    return res.status(500).json({ error: 'Failed to delete upserted chunks' });
  }
});

router.delete('/namespace/:namespace', tokenAuth, async (req, res) => {
  const { namespace } = req.params;

  if (namespace !== req.namespace) {
    return res.status(403).json({ error: 'Access denied' });
  }

  const deleted = await deleteBusinessChunks(req.businessId);
  res.json({ success: true, deletedChunks: deleted });
});

export default router;
