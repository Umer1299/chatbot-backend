import pool from '../db/pool.js';
import { getEmbedding } from './aiService.js';
import { normalizeQuestion } from '../utils/normalizeQuestion.js';

const QUICK_ANSWER_THRESHOLD = Number(process.env.QUICK_ANSWER_THRESHOLD || 0.78);
const QUICK_ANSWER_MAX_WORDS = Number(process.env.QUICK_ANSWER_MAX_WORDS || 35);
const QUICK_ANSWER_MAX_CHARS = Number(process.env.QUICK_ANSWER_MAX_CHARS || 220);
const QUICK_ANSWER_ENABLED = String(process.env.QUICK_ANSWER_ENABLED || 'true').toLowerCase() === 'true';
const QUICK_ANSWER_ALLOW_NULL_EMBEDDING = String(process.env.QUICK_ANSWER_ALLOW_NULL_EMBEDDING || 'false').toLowerCase() === 'true';
const QUICK_ANSWER_EMBEDDING_DIMENSION = 1536;

export class QuickAnswerEmbeddingError extends Error {
  constructor(message) {
    super(message);
    this.name = 'QuickAnswerEmbeddingError';
    this.statusCode = 422;
  }
}

function getSafeErrorMessage(error) {
  return error?.message ? String(error.message) : 'Unknown embedding error';
}

async function generateQuickAnswerEmbedding(question, context = {}) {
  console.log('quick_answer_embedding_generation_started', context);
  try {
    const embedding = await getEmbedding(question);
    if (!embedding) {
      throw new QuickAnswerEmbeddingError('Embedding provider returned no embedding.');
    }
    if (!Array.isArray(embedding) || embedding.length !== QUICK_ANSWER_EMBEDDING_DIMENSION) {
      throw new QuickAnswerEmbeddingError(`Embedding dimension mismatch. Expected ${QUICK_ANSWER_EMBEDDING_DIMENSION}, received ${Array.isArray(embedding) ? embedding.length : 'invalid'}.`);
    }
    console.log('quick_answer_embedding_generation_success', {
      ...context,
      dimension: embedding.length,
    });
    return embedding;
  } catch (error) {
    console.error('quick_answer_embedding_generation_failed', {
      ...context,
      error: getSafeErrorMessage(error),
    });
    if (QUICK_ANSWER_ALLOW_NULL_EMBEDDING) return null;
    if (error instanceof QuickAnswerEmbeddingError) throw error;
    throw new QuickAnswerEmbeddingError('Failed to generate embedding for quick answer question.');
  }
}

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
  const embedding = await generateQuickAnswerEmbedding(question, { businessId, action: 'create' });

  const { rows } = await pool.query(
    `WITH updated AS (
      UPDATE quick_answers
      SET question = $2,
          answer = $4,
          category = $5,
          priority = $6,
          embedding = $7::vector,
          is_active = TRUE,
          updated_at = NOW()
      WHERE business_id = $1
        AND normalized_question = $3
      RETURNING *, FALSE AS inserted
    ), inserted AS (
      INSERT INTO quick_answers
        (business_id, question, normalized_question, answer, category, priority, embedding, is_active)
      SELECT $1, $2, $3, $4, $5, $6, $7::vector, TRUE
      WHERE NOT EXISTS (SELECT 1 FROM updated)
      RETURNING *, TRUE AS inserted
    )
    SELECT * FROM updated
    UNION ALL
    SELECT * FROM inserted
    LIMIT 1`,
    [businessId, question, normalizedQuestion, answer, category, priority, embedding ? JSON.stringify(embedding) : null],
  );

  console.log('quick_answer_created_with_embedding', {
    businessId,
    quickAnswerId: rows[0]?.id || null,
    hasEmbedding: Boolean(embedding),
    inserted: Boolean(rows[0]?.inserted),
  });

  return rows[0] || null;
}

export async function updateQuickAnswer({ businessId, id, question, answer, category, priority, isActive }) {
  const current = await pool.query('SELECT * FROM quick_answers WHERE id = $1 AND business_id = $2 LIMIT 1', [id, businessId]);
  if (!current.rows[0]) return null;

  const nextQuestion = question ?? current.rows[0].question;
  const updates = [nextQuestion, normalizeQuestion(nextQuestion), answer ?? current.rows[0].answer, category ?? current.rows[0].category, priority ?? current.rows[0].priority, isActive ?? current.rows[0].is_active, id, businessId];

  let embedding = current.rows[0].embedding;
  const hasQuestionChanged = typeof question === 'string' && question.trim() && question.trim() !== current.rows[0].question;
  if (hasQuestionChanged) {
    embedding = await generateQuickAnswerEmbedding(question, { businessId, action: 'update', quickAnswerId: id });
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

export async function deleteQuickAnswerByQuestion({ businessId, question }) {
  const normalizedQuestion = normalizeQuestion(question);
  if (!normalizedQuestion) return false;

  const { rowCount } = await pool.query(
    `UPDATE quick_answers
     SET is_active = FALSE,
         updated_at = NOW()
     WHERE business_id = $1
       AND normalized_question = $2
       AND is_active = TRUE`,
    [businessId, normalizedQuestion],
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
  if (!QUICK_ANSWER_ENABLED) return { matched: false, source: 'quick_answer_skipped', skipReason: 'quick_answer_disabled' };

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
  if (safe.length > QUICK_ANSWER_MAX_CHARS) return { matched: false, source: 'quick_answer_skipped', skipReason: 'message_too_long', maxChars: QUICK_ANSWER_MAX_CHARS, chars: safe.length };
  if (wordCount > QUICK_ANSWER_MAX_WORDS) return { matched: false, source: 'quick_answer_skipped', skipReason: 'too_many_words', maxWords: QUICK_ANSWER_MAX_WORDS, words: wordCount };

  const { rows: countRows } = await pool.query(
    `SELECT
      COUNT(*) AS total,
      COUNT(*) FILTER (WHERE is_active = TRUE) AS active,
      COUNT(*) FILTER (WHERE is_active = TRUE AND embedding IS NOT NULL) AS active_with_embeddings
     FROM quick_answers
     WHERE business_id = $1`,
    [businessId],
  );
  const counts = countRows[0] || {};
  const total = Number(counts.total || 0);
  const active = Number(counts.active || 0);
  const activeWithEmbeddings = Number(counts.active_with_embeddings || 0);
  console.log('quick_answer_counts', { businessId, total, active, activeWithEmbeddings });
  if (active === 0) {
    return { matched: false, source: 'quick_answer_skipped', skipReason: 'no_active_quick_answers', debug: { total, active, activeWithEmbeddings } };
  }
  if (activeWithEmbeddings === 0) {
    return { matched: false, source: 'quick_answer_miss', skippedReason: 'no_active_embeddings', debug: { total, active, activeWithEmbeddings }, missReason: 'no_active_embeddings' };
  }

  console.log('quick_answer_semantic_search_started', { businessId });
  const queryEmbedding = await getEmbedding(message);
  if (!queryEmbedding) return { matched: false, source: 'quick_answer_skipped', skipReason: 'embedding_generation_failed', debug: { total, active, activeWithEmbeddings } };

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

  const candidates = semantic.rows.map((row) => ({
    id: row.id,
    question: row.question,
    similarity: Number(row.similarity),
    category: row.category,
    priority: row.priority,
  }));
  const top = semantic.rows[0];
  const topScore = top ? Number(top.similarity) : null;
  const topQuestion = top?.question || null;
  const topQuickAnswerId = top?.id || null;
  const matched = Boolean(top && topScore >= QUICK_ANSWER_THRESHOLD);
  console.log('quick_answer_semantic_result', { businessId, topScore, topQuestion, threshold: QUICK_ANSWER_THRESHOLD, matched, candidates });
  if (!matched) {
    const missReason = top ? 'below_threshold' : 'no_candidates';
    console.log('quick_answer_miss', { businessId, reason: missReason, topScore, topQuestion, threshold: QUICK_ANSWER_THRESHOLD });
    return { matched: false, source: 'quick_answer_miss', score: topScore, topScore, topQuestion, topQuickAnswerId, threshold: QUICK_ANSWER_THRESHOLD, candidates, missReason, debug: { total, active, activeWithEmbeddings, semanticChecked: true, candidates, topScore, topQuestion, threshold: QUICK_ANSWER_THRESHOLD } };
  }

  await recordMatch(top.id);
  return { matched: true, source: 'quick_answer_semantic', answer: top.answer, quickAnswerId: top.id, score: topScore, topQuestion, topQuickAnswerId, threshold: QUICK_ANSWER_THRESHOLD, candidates, debug: { total, active, activeWithEmbeddings, semanticChecked: true, candidates, topScore, topQuestion, threshold: QUICK_ANSWER_THRESHOLD } };
}
