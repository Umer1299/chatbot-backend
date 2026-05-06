import pool from './pool.js';
import { getEmbedding } from '../services/aiService.js';
import { redisClient } from '../services/redis.js';

const BATCH_SIZE = 10;
const BATCH_DELAY_MS = 200;

async function clearRagCache(pattern, logLabel) {
  if (!redisClient) return;

  try {
    const keys = await redisClient.keys(pattern);
    if (keys.length > 0) {
      await redisClient.del(keys);
    }
    console.log(`Cleared RAG cache for ${logLabel}`);
  } catch (error) {
    console.warn('Failed to clear RAG cache:', error.message);
  }
}

async function insertChunkBatch(businessId, chunks, sourceType, startIndex = 0) {
  let inserted = 0;
  let skipped = 0;
  const totalBatches = Math.ceil(chunks.length / BATCH_SIZE);

  for (let i = 0; i < chunks.length; i += BATCH_SIZE) {
    const batch = chunks.slice(i, i + BATCH_SIZE);

    for (let j = 0; j < batch.length; j += 1) {
      const chunk = batch[j];
      const embedding = await getEmbedding(chunk);

      if (!embedding) {
        skipped += 1;
        continue;
      }

      const chunkIndex = startIndex + i + j;
      const wordCount = chunk.split(/\s+/).filter(Boolean).length;

      await pool.query(
        `INSERT INTO knowledge_chunks
          (business_id, content, embedding, source_type, chunk_index, word_count)
         VALUES ($1, $2, $3::vector, $4, $5, $6)`,
        [businessId, chunk, JSON.stringify(embedding), sourceType, chunkIndex, wordCount],
      );

      inserted += 1;
    }

    const batchNumber = Math.floor(i / BATCH_SIZE) + 1;
    console.log(`Embedded batch ${batchNumber} of ${totalBatches}`);
    await new Promise((resolve) => setTimeout(resolve, BATCH_DELAY_MS));
  }

  return { inserted, skipped };
}

export async function setupVectorTable() {
  try {
    await pool.query('CREATE EXTENSION IF NOT EXISTS vector');
    await pool.query(`
      CREATE TABLE IF NOT EXISTS knowledge_chunks (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        business_id UUID NOT NULL,
        content TEXT NOT NULL,
        embedding vector(1536),
        source_url TEXT,
        source_type TEXT DEFAULT 'website',
        chunk_index INTEGER,
        word_count INTEGER,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_chunks_business
      ON knowledge_chunks(business_id)
    `);
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_chunks_embedding
      ON knowledge_chunks
      USING hnsw (embedding vector_cosine_ops)
    `);
    console.log('pgvector table and index ready');
  } catch (error) {
    console.error('Failed to setup pgvector knowledge table:', error.message);
  }
}

export async function upsertChunks(businessId, chunks, sourceType = 'website') {
  try {
    await pool.query(
      'DELETE FROM knowledge_chunks WHERE business_id = $1 AND source_type = $2',
      [businessId, sourceType],
    );

    const { inserted, skipped } = await insertChunkBatch(businessId, chunks, sourceType, 0);
    await clearRagCache(`rag:${businessId}:*`, `business ${businessId}`);

    return { inserted, skipped };
  } catch (error) {
    console.error('Failed to upsert chunks:', error.message);
    return { inserted: 0, skipped: chunks?.length || 0 };
  }
}

export async function upsertSupplementalChunks(businessId, chunks, sourceType = 'owner_upload') {
  try {
    const existing = await pool.query(
      'SELECT COUNT(*)::int AS total FROM knowledge_chunks WHERE business_id = $1',
      [businessId],
    );
    const startIndex = existing.rows[0]?.total || 0;

    const { inserted, skipped } = await insertChunkBatch(businessId, chunks, sourceType, startIndex);
    await clearRagCache(`rag:${businessId}:*`, `business ${businessId}`);

    return { inserted, skipped };
  } catch (error) {
    console.error('Failed to upsert supplemental chunks:', error.message);
    return { inserted: 0, skipped: chunks?.length || 0 };
  }
}

export async function getRelevantChunks(businessId, queryText, namespace, limit = 5) {
  const cacheKey = `rag:${namespace}:${queryText.substring(0, 40).replace(/\s+/g, '-').toLowerCase()}`;

  if (redisClient) {
    try {
      const cached = await redisClient.get(cacheKey);
      if (cached) return JSON.parse(cached);
    } catch (error) {
      console.warn('Redis read failed, using DB fallback:', error.message);
    }
  }

  try {
    const queryEmbedding = await getEmbedding(queryText);

    if (!queryEmbedding) {
      console.warn('Embedding failed for RAG query');
      return [];
    }

    const result = await pool.query(
      `SELECT content,
              1 - (embedding <=> $2::vector) AS similarity
       FROM knowledge_chunks
       WHERE business_id = $1
         AND 1 - (embedding <=> $2::vector) > 0.65
       ORDER BY embedding <=> $2::vector
       LIMIT $3`,
      [businessId, JSON.stringify(queryEmbedding), limit],
    );

    if (redisClient) {
      try {
        await redisClient.setex(cacheKey, 300, JSON.stringify(result.rows));
      } catch (error) {
        console.warn('Redis cache write failed:', error.message);
      }
    }

    return result.rows;
  } catch (error) {
    console.error('Failed to fetch relevant chunks:', error.message);
    return [];
  }
}

export async function deleteBusinessChunks(businessId) {
  try {
    const result = await pool.query(
      'DELETE FROM knowledge_chunks WHERE business_id = $1',
      [businessId],
    );

    await clearRagCache(`rag:${businessId}:*`, `business ${businessId}`);
    return result.rowCount;
  } catch (error) {
    console.error('Failed to delete business chunks:', error.message);
    return 0;
  }
}

export async function getKnowledgeAge(businessId) {
  try {
    const result = await pool.query(
      `SELECT MAX(created_at) AS latest,
              COUNT(*)::int AS total_chunks
       FROM knowledge_chunks
       WHERE business_id = $1`,
      [businessId],
    );

    const row = result.rows[0];

    if (!row?.latest || row.total_chunks === 0) {
      return { ageInDays: null, totalChunks: 0, isStale: false };
    }

    const ageInDays = Math.floor((Date.now() - new Date(row.latest).getTime()) / 86400000);

    return {
      ageInDays,
      totalChunks: row.total_chunks,
      isStale: ageInDays > 30,
    };
  } catch (error) {
    console.error('Failed to get knowledge age:', error.message);
    return { ageInDays: null, totalChunks: 0, isStale: false };
  }
}
