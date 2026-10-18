import { KnowledgeIngestionError, ingestionResult } from '../services/ingestionResult.js';
import { createHash, randomUUID } from 'node:crypto';
import pool from './pool.js';
import { getEmbedding } from '../services/aiService.js';
import { redisClient } from '../services/redis.js';

const BATCH_SIZE = 10;
const BATCH_DELAY_MS = 200;
async function acquireKnowledgeClaim(businessId) {
  const token = randomUUID();
  const result = await pool.query(
    `INSERT INTO legacy_knowledge_mutation_claims(business_id,claim_token,expires_at)
     VALUES($1,$2,clock_timestamp()+interval '30 minutes')
     ON CONFLICT(business_id) DO UPDATE SET claim_token=EXCLUDED.claim_token,
       claimed_at=clock_timestamp(),expires_at=EXCLUDED.expires_at
     WHERE legacy_knowledge_mutation_claims.expires_at<=clock_timestamp()
     RETURNING claim_token`,
    [businessId, token],
  );
  if (result.rows[0]?.claim_token !== token)
    throw Object.assign(new Error('Knowledge mutation already in progress'), { status: 409 });
  return token;
}

async function assertKnowledgeClaim(client, businessId, token) {
  const result = await client.query(
    `SELECT claim_token FROM legacy_knowledge_mutation_claims
     WHERE business_id=$1 FOR UPDATE`,
    [businessId],
  );
  if (result.rows[0]?.claim_token !== token)
    throw Object.assign(new Error('Knowledge mutation claim expired'), { status: 409 });
}

async function releaseKnowledgeClaim(businessId, token) {
  await pool.query(
    'DELETE FROM legacy_knowledge_mutation_claims WHERE business_id=$1 AND claim_token=$2',
    [businessId, token],
  );
}

function validatedChunks(chunks) {
  if (!Array.isArray(chunks) || chunks.some(chunk => typeof chunk !== 'string')) {
    throw Object.assign(new Error('chunks must be an array of strings'), { status: 400 });
  }
  return chunks.filter(chunk => chunk.trim());
}

async function embedChunk(chunk) {
  try {
    const embedding = await getEmbedding(chunk);
    if (!Array.isArray(embedding) || embedding.length === 0 || !embedding.every(Number.isFinite)) {
      throw new Error('Embedding unavailable');
    }
    return embedding;
  } catch (cause) {
    throw new KnowledgeIngestionError(cause, { code: 'KNOWLEDGE_EMBEDDING_FAILED' });
  }
}

async function insertChunk(client, businessId, chunk, embedding, sourceType, index) {
  await client.query(`INSERT INTO knowledge_chunks
    (business_id, content, embedding, source_type, chunk_index, word_count)
    VALUES ($1, $2, $3::vector, $4, $5, $6)`,
  [businessId, chunk, JSON.stringify(embedding), sourceType, index, chunk.split(/\s+/).filter(Boolean).length]);
}

async function ensureBrandColumns() {
  await pool.query(`ALTER TABLE businesses ADD COLUMN IF NOT EXISTS logo_url TEXT`);
  await pool.query(`ALTER TABLE businesses ADD COLUMN IF NOT EXISTS primary_color TEXT`);
  await pool.query(`ALTER TABLE bot_configs ADD COLUMN IF NOT EXISTS logo_url TEXT`);
  await pool.query(`ALTER TABLE bot_configs ADD COLUMN IF NOT EXISTS primary_color TEXT`);
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
    await ensureBrandColumns();
    console.log('pgvector table, indexes, and brand columns ready');
  } catch (error) {
    console.error('Failed to setup pgvector knowledge table:', error.message);
  }
}

export async function upsertChunks(businessId, chunks, sourceType = 'website') {
  const content = validatedChunks(chunks);
  const skipped = chunks.length - content.length;
  if (!content.length) return ingestionResult(0, skipped); // Never erase working data for empty input.
  let client;
  let claim;
  let inTransaction = false;
  try {
    claim = await acquireKnowledgeClaim(businessId);
    // The durable claim serializes the complete mutation with deletion without
    // retaining a pool client during external embedding calls.
    const embeddings = [];
    for (const chunk of content) embeddings.push(await embedChunk(chunk));
    client = await pool.connect();
    await client.query('BEGIN'); inTransaction = true;
    await assertKnowledgeClaim(client, businessId, claim);
    // Serialize replacement for this business; readers keep seeing committed knowledge.
    const business = await client.query('SELECT id FROM businesses WHERE id=$1 FOR UPDATE', [businessId]);
    if (!business.rows.length) throw new Error('Business not found');
    await client.query('DELETE FROM knowledge_chunks WHERE business_id = $1 AND source_type = $2', [businessId, sourceType]);
    for (let i = 0; i < content.length; i++) {
      await insertChunk(client, businessId, content[i], embeddings[i], sourceType, i);
    }
    await client.query('COMMIT'); inTransaction = false;
    return ingestionResult(content.length, skipped);
  } catch (cause) {
    if (inTransaction) await client.query('ROLLBACK').catch(() => {});
    throw new KnowledgeIngestionError(cause, { skipped, failed: content.length,
      code: cause.code === 'KNOWLEDGE_EMBEDDING_FAILED' ? cause.code : 'KNOWLEDGE_INGESTION_FAILED' });
  } finally {
    client?.release();
    if (claim) await releaseKnowledgeClaim(businessId, claim).catch(() => {});
  }
}

export async function upsertSupplementalChunks(businessId, chunks, sourceType = 'owner_upload') {
  const content = validatedChunks(chunks);
  let skipped = chunks.length - content.length;
  let inserted = 0;
  if (!content.length) return ingestionResult(0, skipped);
  let claim;
  try {
    claim = await acquireKnowledgeClaim(businessId);
    // Recheck stored content on retries, independent of Redis dedup expiry/failures.
    const existing = await pool.query('SELECT content FROM knowledge_chunks WHERE business_id=$1 AND source_type=$2 AND content=ANY($3::text[])', [businessId, sourceType, content]);
    const known = new Set(existing.rows.map(row => row.content));
    const count = await pool.query('SELECT COUNT(*)::int AS total FROM knowledge_chunks WHERE business_id = $1', [businessId]);
    const startIndex = count.rows[0]?.total || 0;
    for (let i = 0; i < content.length; i++) {
      const chunk = content[i];
      if (known.has(chunk)) { skipped++; continue; }
      const embedding = await embedChunk(chunk);
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await assertKnowledgeClaim(client, businessId, claim);
        await insertChunk(client, businessId, chunk, embedding, sourceType, startIndex + inserted);
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK').catch(() => {});
        throw error;
      } finally {
        client.release();
      }
      inserted++; known.add(chunk);
      if ((i + 1) % BATCH_SIZE === 0) await new Promise(resolve => setTimeout(resolve, BATCH_DELAY_MS));
    }
    return ingestionResult(inserted, skipped);
  } catch (cause) {
    // Successfully committed chunks (and their DB revisions) are preserved.
    throw new KnowledgeIngestionError(cause, { inserted, skipped, failed: Math.max(0, chunks.length - inserted - skipped),
      code: cause.code === 'KNOWLEDGE_EMBEDDING_FAILED' ? cause.code : 'KNOWLEDGE_INGESTION_FAILED' });
  } finally {
    if (claim) await releaseKnowledgeClaim(businessId, claim).catch(() => {});
  }
}

async function knowledgeRevision(businessId) {
  const { rows } = await pool.query('SELECT knowledge_revision FROM businesses WHERE id=$1', [businessId]);
  const revision = rows[0]?.knowledge_revision;
  if (revision == null || !/^\d+$/.test(String(revision))) throw new Error('Knowledge revision unavailable');
  return String(revision);
}

// Keep the public call signature; namespace is legacy and never scopes this cache.
export async function getRelevantChunks(businessId, queryText, _namespace, limit = 5) {
  const queryHash = createHash('sha256').update(JSON.stringify([queryText, limit])).digest('hex');
  try {
    let queryEmbedding;
    // Retry once if knowledge changed while embedding/retrieval was in progress.
    for (let attempt = 0; attempt < 2; attempt++) {
      const revision = await knowledgeRevision(businessId);
      const cacheKey = `rag:v2:${businessId}:${revision}:${queryHash}`;
      try {
        const cached = await redisClient?.get(cacheKey);
        if (cached) {
          const chunks = JSON.parse(cached);
          if (Array.isArray(chunks) && chunks.length <= limit && chunks.every(chunk =>
            typeof chunk?.content === 'string' && Number.isFinite(chunk.similarity))) return chunks;
        }
      } catch (error) {
        console.warn('Redis read failed, using DB fallback:', error.message);
      }

      queryEmbedding ??= await getEmbedding(queryText);
      if (!queryEmbedding) return [];
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
      if (revision !== await knowledgeRevision(businessId)) continue;
      try {
        await redisClient?.setex(cacheKey, 300, JSON.stringify(result.rows));
      } catch (error) {
        console.warn('Redis cache write failed:', error.message);
      }
      return result.rows;
    }
    // Continuously changing knowledge must not return a stale generation.
    return [];
  } catch (error) {
    console.error('Failed to fetch relevant chunks:', error.message);
    return [];
  }
}

export async function deleteBusinessChunks(businessId) {
  let client;
  let claim;
  let inTransaction = false;
  try {
    claim = await acquireKnowledgeClaim(businessId);
    client = await pool.connect();
    await client.query('BEGIN'); inTransaction = true;
    await assertKnowledgeClaim(client, businessId, claim);
    const result = await client.query(
      'DELETE FROM knowledge_chunks WHERE business_id = $1',
      [businessId],
    );
    await client.query('COMMIT'); inTransaction = false;
    return result.rowCount;
  } catch (error) {
    if (inTransaction) await client.query('ROLLBACK').catch(() => {});
    console.error('Failed to delete business chunks:', error.message);
    throw error;
  } finally {
    client?.release();
    if (claim) await releaseKnowledgeClaim(businessId, claim).catch(() => {});
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
