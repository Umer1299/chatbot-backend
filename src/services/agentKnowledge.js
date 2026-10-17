import { createHash } from "node:crypto";
import pool from "../db/pool.js";
import { getEmbedding } from "./aiService.js";
import { redisClient } from "./redis.js";
import { inTransaction, resourceNotFound } from "./agencyAccess.js";

const fail = (status, message) => Object.assign(new Error(message), { status });
const sha = (value) => createHash("sha256").update(value).digest("hex");
function chunksOf(text) {
  const chunks = [];
  for (let i = 0; i < text.length; i += 1000)
    chunks.push(text.slice(i, i + 1000));
  return chunks;
}
async function embeddingFor(text, embed) {
  const result = await embed(text);
  if (
    !Array.isArray(result) ||
    result.length !== 1536 ||
    !result.every(Number.isFinite)
  )
    throw fail(502, "Embedding unavailable");
  return JSON.stringify(result);
}
export async function saveAgentKnowledge({
  businessId,
  agentId,
  sourceKey,
  text,
  db = pool,
  embed = getEmbedding,
  authorize,
}) {
  if (
    typeof sourceKey !== "string" ||
    !/^[a-zA-Z0-9_-]{1,100}$/.test(sourceKey) ||
    typeof text !== "string" ||
    !text.trim() ||
    text.length > 20000
  )
    throw fail(400, "Invalid text knowledge");
  const content = text.trim(),
    digest = sha(content),
    chunks = chunksOf(content);
  const agent = (
    await db.query(
      "SELECT id FROM agents WHERE id=$1 AND business_id=$2 AND status<>'archived'",
      [agentId, businessId],
    )
  ).rows[0];
  if (!agent) throw resourceNotFound();
  const existing = await db.query(
    "SELECT id,content_hash FROM agent_knowledge_sources WHERE business_id=$1 AND agent_id=$2 AND source_key=$3",
    [businessId, agentId, sourceKey],
  );
  // The locked recheck below handles racing updates. This read avoids unnecessary embeddings on retries.
  if (existing.rows[0]?.content_hash === digest)
    return {
      inserted: 0,
      skipped: chunks.length,
      status: "skipped",
      sourceId: existing.rows[0].id,
    };
  const vectors = [];
  for (const chunk of chunks) vectors.push(await embeddingFor(chunk, embed));
  return inTransaction(async (client) => {
    if (authorize) await authorize(client);
    const agent = (
      await client.query(
        "SELECT id FROM agents WHERE id=$1 AND business_id=$2 AND status<>'archived' FOR UPDATE",
        [agentId, businessId],
      )
    ).rows[0];
    if (!agent) throw resourceNotFound();
    const old = (
      await client.query(
        "SELECT id,content_hash FROM agent_knowledge_sources WHERE business_id=$1 AND agent_id=$2 AND source_key=$3",
        [businessId, agentId, sourceKey],
      )
    ).rows[0];
    if (old?.content_hash === digest)
      return {
        inserted: 0,
        skipped: chunks.length,
        status: "skipped",
        sourceId: old.id,
      };
    let sourceId = old?.id;
    if (old) {
      await client.query(
        "DELETE FROM agent_knowledge_chunks WHERE source_id=$1 AND business_id=$2 AND agent_id=$3",
        [sourceId, businessId, agentId],
      );
      await client.query(
        "UPDATE agent_knowledge_sources SET content_hash=$1,updated_at=now() WHERE id=$2 AND business_id=$3 AND agent_id=$4",
        [digest, sourceId, businessId, agentId],
      );
    } else {
      sourceId = (
        await client.query(
          "INSERT INTO agent_knowledge_sources(business_id,agent_id,source_key,content_hash) VALUES($1,$2,$3,$4) RETURNING id",
          [businessId, agentId, sourceKey, digest],
        )
      ).rows[0].id;
    }
    for (let i = 0; i < chunks.length; i++)
      await client.query(
        "INSERT INTO agent_knowledge_chunks(source_id,business_id,agent_id,content,embedding,chunk_index) VALUES($1,$2,$3,$4,$5::vector,$6)",
        [sourceId, businessId, agentId, chunks[i], vectors[i], i],
      );
    return {
      inserted: chunks.length,
      skipped: 0,
      status: "completed",
      sourceId,
    };
  }, db);
}
export async function deleteAgentKnowledge({
  businessId,
  agentId,
  sourceId,
  db = pool,
  authorize,
}) {
  return inTransaction(async (client) => {
    if (authorize) await authorize(client);
    const agent = (
      await client.query(
        "SELECT id FROM agents WHERE id=$1 AND business_id=$2 FOR UPDATE",
        [agentId, businessId],
      )
    ).rows[0];
    if (!agent) throw resourceNotFound();
    const result = await client.query(
      "DELETE FROM agent_knowledge_sources WHERE id=$1 AND business_id=$2 AND agent_id=$3 RETURNING id",
      [sourceId, businessId, agentId],
    );
    if (!result.rows[0]) throw resourceNotFound();
    return result.rows[0];
  }, db);
}
async function revision(db, businessId, agentId) {
  const r = await db.query(
    "SELECT knowledge_revision FROM agents WHERE id=$1 AND business_id=$2",
    [agentId, businessId],
  );
  const value = r.rows[0]?.knowledge_revision;
  if (value == null || !/^\d+$/.test(String(value)))
    throw fail(503, "Agent knowledge unavailable");
  return String(value);
}
export async function retrieveAgentKnowledge({
  businessId,
  agentId,
  query,
  limit = 5,
  db = pool,
  embed = getEmbedding,
  cache = redisClient,
}) {
  if (
    typeof query !== "string" ||
    !query.trim() ||
    query.length > 4000 ||
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > 10
  )
    throw fail(400, "Invalid retrieval request");
  const hash = sha(JSON.stringify([query, limit, 0.65]));
  for (let attempt = 0; attempt < 3; attempt++) {
    const before = await revision(db, businessId, agentId);
    const key = `rag:agent:v1:${businessId}:${agentId}:${before}:${hash}`;
    let cached;
    try {
      const raw = await cache?.get(key);
      if (raw) {
        const value = JSON.parse(raw);
        if (
          Array.isArray(value) &&
          value.length <= limit &&
          value.every(
            (row) =>
              typeof row.content === "string" &&
              Number.isFinite(row.similarity),
          )
        )
          cached = value;
      }
    } catch {
      /* Redis availability does not authorize or invalidate SQL. */
    }
    if (cached) {
      if (before === (await revision(db, businessId, agentId))) return cached;
      continue;
    }
    const vector = await embeddingFor(query, embed);
    const rows = (
      await db.query(
        `SELECT content,1-(embedding <=> $3::vector) AS similarity FROM agent_knowledge_chunks
      WHERE business_id=$1 AND agent_id=$2 AND 1-(embedding <=> $3::vector)>0.65
      ORDER BY embedding <=> $3::vector,id LIMIT $4`,
        [businessId, agentId, vector, limit],
      )
    ).rows;
    if (before !== (await revision(db, businessId, agentId))) continue;
    try {
      await cache?.setex(key, 300, JSON.stringify(rows));
    } catch {
      /* DB result remains authoritative. */
    }
    return rows;
  }
  // Fail closed on a continuously changing knowledge set; never serve an older cache generation.
  throw fail(503, "Agent knowledge changed during retrieval");
}
