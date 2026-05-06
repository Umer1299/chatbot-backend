import { Router } from 'express';
import multer from 'multer';
import pool from '../db/pool.js';
import requireAuth from '../middleware/jwtAuth.js';
import { addScrapeJob, getJobStatus, refreshScrapeJob } from '../jobs/scrapeWorker.js';
import { processSupplementalInfo } from '../agents/contentValidator.js';

const router = Router();
const multerUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
});

router.post('/start', requireAuth, async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'URL required' });
  const jobId = await addScrapeJob(req.business.businessId, url);
  return res.json({ jobId, message: 'Scraping started' });
});

router.get('/status/:jobId', requireAuth, async (req, res) => {
  const job = await getJobStatus(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  return res.json(job);
});

router.post('/refresh', requireAuth, async (req, res) => {
  const { url } = req.body;
  const jobId = await refreshScrapeJob(req.business.businessId, url);
  return res.json({ jobId, message: 'Re-scrape started' });
});

router.post('/supplement/text', requireAuth, async (req, res) => {
  const { content } = req.body;
  if (!content || content.length < 50) {
    return res.status(400).json({ error: 'Please provide at least 50 characters' });
  }

  const businessResult = await pool.query('SELECT industry FROM businesses WHERE id = $1', [req.business.businessId]);
  const businessRow = businessResult.rows[0];

  const result = await processSupplementalInfo(req.business.businessId, content, businessRow?.industry || req.business.industry);
  return res.json(result);
});

router.post('/supplement/file', requireAuth, multerUpload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

  let extractedText = '';

  if (req.file.mimetype === 'text/plain') {
    extractedText = req.file.buffer.toString('utf8');
  } else if (req.file.mimetype === 'application/pdf') {
    return res.status(400).json({ error: 'PDF parsing not supported yet' });
  } else if (req.file.mimetype === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') {
    return res.status(400).json({ error: 'DOCX parsing not supported yet' });
  } else {
    return res.status(400).json({ error: 'Unsupported file type' });
  }

  const businessResult = await pool.query('SELECT industry FROM businesses WHERE id = $1', [req.business.businessId]);
  const business = businessResult.rows[0];

  const result = await processSupplementalInfo(
    req.business.businessId,
    extractedText,
    business?.industry || req.business.industry,
  );
  return res.json(result);
});

export default router;
