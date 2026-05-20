import pool from '../db/pool.js';
import { getEmbedding } from './aiService.js';
import { normalizeQuestion } from '../utils/normalizeQuestion.js';

const QUICK_ANSWER_THRESHOLD = Number(process.env.QUICK_ANSWER_THRESHOLD || 0.86);
const QUICK_ANSWER_MAX_WORDS = Number(process.env.QUICK_ANSWER_MAX_WORDS || 35);
const QUICK_ANSWER_MAX_CHARS = Number(process.env.QUICK_ANSWER_MAX_CHARS || 220);
const QUICK_ANSWER_ENABLED = String(process.env.QUICK_ANSWER_ENABLED || 'true').toLowerCase() === 'true';

function isComplexMessage(message = '') {
  const safe = String(message || '').trim();
  if (!safe) return true;
  if (safe.length > QUICK_ANSWER_MAX_CHARS) return true;

  const wordCount = safe.split(/\s+/).filter(Boolean).length;
  if (wordCount > QUICK_ANSWER_MAX_WORDS) return true;

  const commas = (safe.match(/,/g) || []).length;
  const ands = (safe.match(/\band\b/gi) || []).length;
  return commas >= 2 || ands >= 3;
}

async function recordMatch(id) {
  await pool.query(
    `UPDATE quick_answers
     SET match_count = match_count + 1,
         last_matched_at = NOW(),
         updated_at = NOW()
     WHERE id = $1`,
    [id],
  );
}

export async function createQuickAnswer({ businessId, question, answer, category = 'general', priority = 0 }) {
  const normalizedQuestion = normalizeQuestion(question);
  const embedding = await getEmbedding(question);

  const { rows } = await pool.query(
    `INSERT INTO quick_answers
      (business_id, question, normalized_question, answer, category, priority, embedding)
     VALUES ($1, $2, $3, $4, $5, $6, $7::vector)
     RETURNING *`,
    [businessId, question, normalizedQuestion, answer, category, priority, embedding ? JSON.stringify(embedding) : null],
  );

  return rows[0] || null;
}

export async function updateQuickAnswer({ businessId, id, question, answer, category, priority, isActive }) {
  const current = await pool.query('SELECT * FROM quick_answers WHERE id = $1 AND business_id = $2 LIMIT 1', [id, businessId]);
  if (!current.rows[0]) return null;

  const nextQuestion = question ?? current.rows[0].question;
  const updates = [nextQuestion, normalizeQuestion(nextQuestion), answer ?? current.rows[0].answer, category ?? current.rows[0].category, priority ?? current.rows[0].priority, isActive ?? current.rows[0].is_active, id, businessId];

  let embedding = current.rows[0].embedding;
  if (typeof question === 'string' && question.trim()) {
    embedding = await getEmbedding(question);
  }

  const { rows } = await pool.query(
    `UPDATE quick_answers
     SET question = $1,
         normalized_question = $2,
         answer = $3,
         category = $4,
         priority = $5,
         is_active = $6,
         embedding = $9::vector,
         updated_at = NOW()
     WHERE id = $7 AND business_id = $8
     RETURNING *`,
    [...updates, embedding ? JSON.stringify(embedding) : null],
  );

  return rows[0] || null;
}

export async function deleteQuickAnswer({ businessId, id }) {
  const { rowCount } = await pool.query(
    `UPDATE quick_answers
     SET is_active = FALSE,
         updated_at = NOW()
     WHERE id = $1 AND business_id = $2`,
    [id, businessId],
  );

  return rowCount > 0;
}

export async function listQuickAnswers({ businessId }) {
  const { rows } = await pool.query(
    `SELECT id, question, normalized_question, answer, category, priority, is_active,
            match_count, last_matched_at, created_at, updated_at
     FROM quick_answers
     WHERE business_id = $1
     ORDER BY priority DESC, created_at DESC`,
    [businessId],
  );

  return rows;
}

export async function tryQuickAnswer({ businessId, message }) {
  if (!businessId) return { matched: false, source: 'quick_answer_skipped', skipReason: 'missing_business_id' };
  if (!QUICK_ANSWER_ENABLED) return { matched: false, source: 'quick_answer_skipped', skipReason: 'disabled' };

  const normalizedMessage = normalizeQuestion(message);
  if (!normalizedMessage) return { matched: false, source: 'quick_answer_skipped', skipReason: 'empty_message' };

  const exact = await pool.query(
    `SELECT *
     FROM quick_answers
     WHERE business_id = $1 AND is_active = TRUE AND normalized_question = $2
     ORDER BY priority DESC, created_at DESC
     LIMIT 1`,
    [businessId, normalizedMessage],
  );

  if (exact.rows[0]) {
    await recordMatch(exact.rows[0].id);
    return { matched: true, source: 'quick_answer_exact', answer: exact.rows[0].answer, quickAnswerId: exact.rows[0].id, score: 1 };
  }

  const safe = String(message || '').trim();
  const wordCount = safe ? safe.split(/\s+/).filter(Boolean).length : 0;
  if (safe.length > QUICK_ANSWER_MAX_CHARS) return { matched: false, source: 'quick_answer_skipped', skipReason: 'max_chars', maxChars: QUICK_ANSWER_MAX_CHARS, chars: safe.length };
  if (wordCount > QUICK_ANSWER_MAX_WORDS) return { matched: false, source: 'quick_answer_skipped', skipReason: 'max_words', maxWords: QUICK_ANSWER_MAX_WORDS, words: wordCount };
  if (isComplexMessage(message)) return { matched: false, source: 'quick_answer_miss', missReason: 'complex_message' };

  const queryEmbedding = await getEmbedding(message);
  if (!queryEmbedding) return { matched: false, source: 'quick_answer_miss', missReason: 'embedding_unavailable' };

  const semantic = await pool.query(
    `SELECT id, question, answer, category, priority,
            1 - (embedding <=> $2::vector) AS similarity
     FROM quick_answers
     WHERE business_id = $1
       AND is_active = TRUE
       AND embedding IS NOT NULL
     ORDER BY embedding <=> $2::vector
     LIMIT 3`,
    [businessId, JSON.stringify(queryEmbedding)],
  );

  const top = semantic.rows[0];
  if (!top || Number(top.similarity) < QUICK_ANSWER_THRESHOLD) {
    return { matched: false, source: 'quick_answer_miss', topScore: top ? Number(top.similarity) : null, threshold: QUICK_ANSWER_THRESHOLD };
  }

  await recordMatch(top.id);
  return { matched: true, source: 'quick_answer_semantic', answer: top.answer, quickAnswerId: top.id, score: Number(top.similarity) };
}
