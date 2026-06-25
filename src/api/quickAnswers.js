import { Router } from 'express';
import pool from '../db/pool.js';
import requireAuth from '../middleware/jwtAuth.js';
import { getEmbedding } from '../services/aiService.js';
import { redisClient } from '../services/redis.js';

const router = Router();
let quickAnswersTableReady = false;

function normalizeQuestion(value = '') {
  return String(value || '')
    .toLowerCase()
    .trim()
    .replace(/[’']/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function parseBoolean(value, fallback = true) {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  return ['true', '1', 'yes', 'active'].includes(String(value).toLowerCase().trim());
}

function getQuestionFromBody(body = {}) {
  return body.question || body.prompt || body.title || body.query || body.quickAnswerQuestion;
}

function getAnswerFromBody(body = {}) {
  return body.answer || body.response || body.text || body.content || body.quickAnswerAnswer;
}

async function ensureQuickAnswersTable() {
  if (quickAnswersTableReady) return;

  await pool.query('CREATE EXTENSION IF NOT EXISTS vector');
  await pool.query(`
    CREATE TABLE IF NOT EXISTS quick_answers (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
      question TEXT NOT NULL,
      answer TEXT NOT NULL,
      normalized_key TEXT DEFAULT '',
      normalized_question TEXT DEFAULT '',
      embedding vector(1536),
      active BOOLEAN DEFAULT true,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  await pool.query(`ALTER TABLE quick_answers ADD COLUMN IF NOT EXISTS normalized_key TEXT DEFAULT ''`);
  await pool.query(`ALTER TABLE quick_answers ADD COLUMN IF NOT EXISTS normalized_question TEXT DEFAULT ''`);
  await pool.query(`ALTER TABLE quick_answers ADD COLUMN IF NOT EXISTS embedding vector(1536)`);
  await pool.query(`ALTER TABLE quick_answers ADD COLUMN IF NOT EXISTS active BOOLEAN DEFAULT true`);
  await pool.query(`ALTER TABLE quick_answers ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT NOW()`);
  await pool.query(`ALTER TABLE quick_answers ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW()`);

  await pool.query(`
    UPDATE quick_answers
    SET normalized_key = lower(regexp_replace(question, '[^a-zA-Z0-9]+', ' ', 'g'))
    WHERE normalized_key IS NULL OR normalized_key = ''
  `);
  await pool.query(`
    UPDATE quick_answers
    SET normalized_question = COALESCE(NULLIF(normalized_key, ''), lower(regexp_replace(question, '[^a-zA-Z0-9]+', ' ', 'g')))
    WHERE normalized_question IS NULL OR normalized_question = ''
  `);

  await pool.query(`UPDATE quick_answers SET active = true WHERE active IS NULL`);
  await pool.query(`ALTER TABLE quick_answers ALTER COLUMN normalized_key SET DEFAULT ''`);
  await pool.query(`ALTER TABLE quick_answers ALTER COLUMN normalized_question SET DEFAULT ''`);
  await pool.query(`ALTER TABLE quick_answers ALTER COLUMN active SET DEFAULT true`);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_quick_answers_business
    ON quick_answers(business_id)
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_quick_answers_normalized_key
    ON quick_answers(business_id, normalized_key)
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_quick_answers_normalized_question
    ON quick_answers(business_id, normalized_question)
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_quick_answers_embedding
    ON quick_answers
    USING hnsw (embedding vector_cosine_ops)
  `);

  quickAnswersTableReady = true;
}

async function clearQuickAnswerCache(businessId) {
  try {
    const businessResult = await pool.query(
      'SELECT bot_id FROM businesses WHERE id = $1',
      [businessId],
    );
    const botId = businessResult.rows[0]?.bot_id;

    if (botId && redisClient) {
      await redisClient.del(`quick_answers:${botId}`);
      await redisClient.del(`chatbot_config:${botId}`);
    }
  } catch (error) {
    console.warn('[quick-answers/cache]', error.message);
  }
}

router.use(requireAuth);

router.get('/', async (req, res) => {
  try {
    const businessId = req.business.businessId;
    if (!businessId) return res.status(400).json({ error: 'businessId missing from token' });

    await ensureQuickAnswersTable();

    const result = await pool.query(
      `SELECT id, question, answer, normalized_key, normalized_question, active, created_at, updated_at
       FROM quick_answers
       WHERE business_id = $1
       ORDER BY created_at DESC`,
      [businessId],
    );

    return res.json({ quickAnswers: result.rows });
  } catch (err) {
    console.error('[quick-answers/get]', err.message, err.stack);
    return res.status(500).json({ error: 'Failed to fetch quick answers', message: err.message });
  }
});

router.post('/', async (req, res) => {
  try {
    const businessId = req.business.businessId;
    if (!businessId) return res.status(400).json({ error: 'businessId missing from token' });

    const question = String(getQuestionFromBody(req.body) || '').trim();
    const answer = String(getAnswerFromBody(req.body) || '').trim();
    const active = parseBoolean(req.body.active, true);

    if (!question || !answer) {
      return res.status(400).json({ error: 'question and answer are required' });
    }

    await ensureQuickAnswersTable();

    const normalizedKey = normalizeQuestion(question);
    const embedding = await getEmbedding(`${question}\n${answer}`);

    const result = await pool.query(
      `INSERT INTO quick_answers
        (business_id, question, answer, normalized_key, normalized_question, embedding, active, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6::vector, $7, NOW(), NOW())
       RETURNING id, question, answer, normalized_key, normalized_question, active, created_at, updated_at`,
      [
        businessId,
        question,
        answer,
        normalizedKey,
        normalizedKey,
        embedding ? JSON.stringify(embedding) : null,
        active,
      ],
    );

    await clearQuickAnswerCache(businessId);

    return res.status(201).json({ success: true, quickAnswer: result.rows[0] });
  } catch (err) {
    console.error('[quick-answers/post]', err.message, err.stack);
    return res.status(500).json({ error: 'Failed to save quick answer', message: err.message });
  }
});

router.patch('/:id', async (req, res) => {
  try {
    const businessId = req.business.businessId;
    if (!businessId) return res.status(400).json({ error: 'businessId missing from token' });

    await ensureQuickAnswersTable();

    const existingResult = await pool.query(
      'SELECT * FROM quick_answers WHERE id = $1 AND business_id = $2',
      [req.params.id, businessId],
    );
    const existing = existingResult.rows[0];
    if (!existing) return res.status(404).json({ error: 'Quick answer not found' });

    const question = String(getQuestionFromBody(req.body) ?? existing.question).trim();
    const answer = String(getAnswerFromBody(req.body) ?? existing.answer).trim();
    const active = parseBoolean(req.body.active, existing.active);

    if (!question || !answer) {
      return res.status(400).json({ error: 'question and answer cannot be empty' });
    }

    const normalizedKey = normalizeQuestion(question);
    const shouldRegenerateEmbedding = question !== existing.question || answer !== existing.answer;
    const embedding = shouldRegenerateEmbedding ? await getEmbedding(`${question}\n${answer}`) : null;

    const result = await pool.query(
      `UPDATE quick_answers
       SET question = $1,
           answer = $2,
           normalized_key = $3,
           normalized_question = $3,
           active = $4,
           embedding = CASE WHEN $5::vector IS NULL THEN embedding ELSE $5::vector END,
           updated_at = NOW()
       WHERE id = $6 AND business_id = $7
       RETURNING id, question, answer, normalized_key, normalized_question, active, created_at, updated_at`,
      [
        question,
        answer,
        normalizedKey,
        active,
        embedding ? JSON.stringify(embedding) : null,
        req.params.id,
        businessId,
      ],
    );

    await clearQuickAnswerCache(businessId);

    return res.json({ success: true, quickAnswer: result.rows[0] });
  } catch (err) {
    console.error('[quick-answers/patch]', err.message, err.stack);
    return res.status(500).json({ error: 'Failed to update quick answer', message: err.message });
  }
});

router.delete('/:id', async (req, res) => {
  try {
    const businessId = req.business.businessId;
    if (!businessId) return res.status(400).json({ error: 'businessId missing from token' });

    await ensureQuickAnswersTable();

    const result = await pool.query(
      `DELETE FROM quick_answers
       WHERE id = $1 AND business_id = $2
       RETURNING id`,
      [req.params.id, businessId],
    );

    if (!result.rows[0]) return res.status(404).json({ error: 'Quick answer not found' });

    await clearQuickAnswerCache(businessId);

    return res.json({ success: true, deletedId: result.rows[0].id });
  } catch (err) {
    console.error('[quick-answers/delete]', err.message, err.stack);
    return res.status(500).json({ error: 'Failed to delete quick answer', message: err.message });
  }
});

export default router;
