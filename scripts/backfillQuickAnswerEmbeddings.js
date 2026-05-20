import pool from '../src/db/pool.js';
import { getEmbedding } from '../src/services/aiService.js';

const EMBEDDING_DIMENSION = 1536;

function safeMessage(error) {
  return error?.message ? String(error.message) : 'Unknown error';
}

async function backfillQuickAnswerEmbeddings() {
  const { rows } = await pool.query(
    `SELECT id, business_id, question
     FROM quick_answers
     WHERE is_active = TRUE
       AND embedding IS NULL`,
  );

  console.log('quick_answer_embedding_backfill_started', { total: rows.length });

  let updated = 0;
  let failed = 0;

  for (const row of rows) {
    try {
      console.log('quick_answer_embedding_generation_started', {
        action: 'backfill',
        quickAnswerId: row.id,
        businessId: row.business_id,
      });

      const embedding = await getEmbedding(row.question);

      if (!embedding || !Array.isArray(embedding)) {
        throw new Error('Embedding provider returned no embedding.');
      }
      if (embedding.length !== EMBEDDING_DIMENSION) {
        throw new Error(`Embedding dimension mismatch. Expected ${EMBEDDING_DIMENSION}, received ${embedding.length}.`);
      }

      await pool.query(
        `UPDATE quick_answers
         SET embedding = $1::vector,
             updated_at = NOW()
         WHERE id = $2 AND business_id = $3`,
        [JSON.stringify(embedding), row.id, row.business_id],
      );

      updated += 1;
      console.log('quick_answer_embedding_generation_success', {
        action: 'backfill',
        quickAnswerId: row.id,
        businessId: row.business_id,
        dimension: embedding.length,
      });
    } catch (error) {
      failed += 1;
      console.error('quick_answer_embedding_generation_failed', {
        action: 'backfill',
        quickAnswerId: row.id,
        businessId: row.business_id,
        error: safeMessage(error),
      });
    }
  }

  console.log('quick_answer_embedding_backfill_completed', { total: rows.length, updated, failed });
}

backfillQuickAnswerEmbeddings()
  .catch((error) => {
    console.error('quick_answer_embedding_backfill_fatal', { error: safeMessage(error) });
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
  });
