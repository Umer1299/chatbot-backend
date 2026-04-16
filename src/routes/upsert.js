import express from 'express';
import multer from 'multer';
import { fileQueue } from '../queues/fileQueue.js';
import { getVectorStore, initPinecone } from '../services/pinecone.js';
import { isDuplicateContent } from '../services/recordManager.js';
import { RecursiveCharacterTextSplitter } from 'langchain/text_splitter';
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
      const splitter = new RecursiveCharacterTextSplitter({ chunkSize: 1000, chunkOverlap: 200 });
      const chunks = await splitter.splitDocuments([{ pageContent: text, metadata: { source: 'text' } }]);
      const vectorStore = await getVectorStore(namespace);
      await vectorStore.addDocuments(chunks);
      return res.json({ success: true, chunksUpserted: chunks.length });
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
      await redisClient.setex(`job:${jobId}`, 86400, JSON.stringify({ status: 'queued' }));
      console.log(`File queued: ${file.originalname} for namespace ${namespace}, job ${jobId}`);
    }
    res.json({ success: true, queued: true, jobIds });
  } catch (err) {
    console.error('Upsert error:', err);
    res.status(500).json({ error: err.message });
  }
});

router.get('/job/:jobId', async (req, res) => {
  const { jobId } = req.params;
  const data = await redisClient.get(`job:${jobId}`);
  if (!data) return res.status(404).json({ error: 'Job not found' });
  res.json(JSON.parse(data));
});

router.delete('/namespace/:namespace', tokenAuth, async (req, res) => {
  const { namespace } = req.params;
  const { client } = await initPinecone();
  const index = client.Index(process.env.PINECONE_INDEX);
  await index.namespace(namespace).deleteAll();
  res.json({ success: true });
});

export default router;