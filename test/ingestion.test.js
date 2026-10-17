import { test, mock, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import fs from "node:fs/promises";

let chunks,
  revision,
  cache,
  calls,
  failDb,
  failContent,
  embeddingMode,
  inputChunks,
  queued,
  queueMode;
const A = "business-a";
const db = {
  query: async (sql, args = []) => {
    const q = sql.replace(/\s+/g, " ").trim();
    calls.push({ q, args });
    if (failDb) throw Error("Database unavailable");
    if (q.startsWith("SELECT id FROM businesses")) return { rows: [{ id: A }] };
    if (q.startsWith("SELECT content FROM knowledge_chunks"))
      return {
        rows: chunks
          .filter(
            (c) =>
              c.business === args[0] &&
              c.source === args[1] &&
              args[2].includes(c.content),
          )
          .map((c) => ({ content: c.content })),
      };
    if (q.startsWith("SELECT COUNT"))
      return {
        rows: [{ total: chunks.filter((c) => c.business === args[0]).length }],
      };
    if (q.startsWith("DELETE FROM knowledge_chunks")) {
      chunks = chunks.filter(
        (c) => c.business !== args[0] || c.source !== args[1],
      );
      revision++;
      return { rows: [] };
    }
    if (q.startsWith("INSERT INTO knowledge_chunks")) {
      if (args[1] === failContent) throw Error("Write failed");
      chunks.push({ business: args[0], content: args[1], source: args[3] });
      revision++;
      return { rows: [], rowCount: 1 };
    }
    throw Error(`Unexpected SQL ${q}`);
  },
};
db.connect = async () => {
  if (failDb) throw Error("Database unavailable");
  let snapshot;
  return {
    release() {},
    query: async (sql, args) => {
      if (sql === "BEGIN") {
        snapshot = { chunks: structuredClone(chunks), revision };
        return { rows: [] };
      }
      if (sql === "ROLLBACK") {
        chunks = snapshot.chunks;
        revision = snapshot.revision;
        return { rows: [] };
      }
      if (sql === "COMMIT") return { rows: [] };
      return db.query(sql, args);
    },
  };
};
mock.module("../src/db/pool.js", { defaultExport: db });
mock.module("../src/services/redis.js", {
  namedExports: {
    redisClient: {
      get: async (k) => cache.get(k) || null,
      setex: async (k, ttl, v) => cache.set(k, v),
    },
  },
});
mock.module("../src/services/aiService.js", {
  namedExports: {
    getEmbedding: async (text) => {
      if (embeddingMode === "throw" || text === "bad embedding")
        throw Error("Provider unavailable");
      return embeddingMode === "null" ? null : [1, 0, 0];
    },
  },
});
mock.module("../src/middleware/knowledgeAuth.js", {
  namedExports: {
    requireKnowledgeOwner: (req, res, next) => {
      req.business = { businessId: A, botId: "bot-a" };
      req.namespace = "bot-a";
      next();
    },
  },
});
mock.module("../src/queues/fileQueue.js", {
  namedExports: {
    fileQueue: {
      getJob: async (id) => {
        if (
          queueMode === "preflight-outage" ||
          (queueMode === "reject" && queued.some((job) => job.jobId === id))
        )
          throw Error("Queue unavailable");
        if (
          queueMode === "accepted-reject" &&
          queued.some((job) => job.jobId === id)
        )
          return { id };
        return null;
      },
      add: async (name, data, options) => {
        assert.equal(options.jobId, data.jobId);
        queued.push(data);
        assert.equal(
          JSON.parse(cache.get(`job:${data.jobId}`)).status,
          "queued",
        );
        if (
          ["reject", "confirmed-reject", "accepted-reject"].includes(queueMode)
        )
          throw Error("Queue unavailable");
        if (queueMode.startsWith("fast-failure"))
          cache.set(
            `job:${data.jobId}`,
            JSON.stringify({
              status: "failed",
              namespace: data.namespace,
              businessId: data.businessId,
            }),
          );
        if (queueMode === "fast-failure-reject")
          throw Error("Lost acknowledgement");
      },
    },
  },
});
mock.module("../src/services/firecrawlService.js", {
  namedExports: {
    cleanAndChunkContent: () => inputChunks,
    shouldEmbedChunk: () => true,
  },
});
const { upsertChunks, upsertSupplementalChunks } =
  await import("../src/db/vectorStore.js");
const { isDuplicateContent } = await import("../src/services/recordManager.js");
const app = express();
app.use(express.json());
app.use("/upsert", (await import("../src/routes/upsert.js")).default);
const server = await new Promise((resolve) => {
  const s = app.listen(0, "127.0.0.1", () => resolve(s));
});
after(() => new Promise((resolve) => server.close(resolve)));
async function upload(text = "same retryable upload") {
  const r = await fetch(`http://127.0.0.1:${server.address().port}/upsert`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text }),
  });
  return { status: r.status, body: await r.json() };
}
beforeEach(() => {
  chunks = [
    { business: A, content: "working website", source: "website" },
    { business: A, content: "owner knowledge", source: "owner_upload" },
    { business: "business-b", content: "private B", source: "website" },
  ];
  revision = 7;
  cache = new Map();
  calls = [];
  failDb = false;
  failContent = undefined;
  embeddingMode = "ok";
  inputChunks = ["new one", "new two"];
  queued = [];
  queueMode = "success";
});

test("database failures reject helper and API with no success marker", async () => {
  failDb = true;
  await assert.rejects(
    upsertSupplementalChunks(A, ["new"]),
    (e) => e.result.status === "failed" && e.result.inserted === 0,
  );
  const r = await upload();
  assert.equal(r.status, 500);
  assert.equal(r.body.success, false);
  assert.equal(
    await isDuplicateContent("same retryable upload", "bot-a"),
    false,
  );
});
test("null and thrown embedding errors are operational failures, never successful empty ingestion", async () => {
  for (const mode of ["null", "throw"]) {
    embeddingMode = mode;
    const r = await upload();
    assert.equal(r.status, 502);
    assert.equal(r.body.success, false);
    assert.equal(r.body.code, "KNOWLEDGE_EMBEDDING_FAILED");
    assert.equal(
      await isDuplicateContent("same retryable upload", "bot-a"),
      false,
    );
  }
  assert.equal(chunks.length, 3);
});
test("partial supplemental failure reports confirmed commits; retry preserves them and skips stored content", async () => {
  failContent = "new two";
  const r = await upload();
  assert.equal(r.status, 503);
  assert.equal(r.body.success, false);
  assert.deepEqual(r.body.ingestion, {
    inserted: 1,
    skipped: 0,
    failed: 1,
    status: "partial",
  });
  assert.equal(revision, 8);
  assert.ok(chunks.some((c) => c.content === "new one"));
  assert.equal(
    await isDuplicateContent("same retryable upload", "bot-a"),
    false,
  );
  failContent = undefined;
  const retry = await upload();
  assert.equal(retry.status, 200);
  assert.equal(retry.body.chunksUpserted, 1);
  assert.equal(chunks.filter((c) => c.content === "new one").length, 1);
  assert.equal((await upload()).body.skipped, true);
});
test("partial embedding failure retains confirmed inserts and reports an error", async () => {
  await assert.rejects(
    upsertSupplementalChunks(A, ["new one", "bad embedding"]),
    (e) =>
      e.code === "KNOWLEDGE_EMBEDDING_FAILED" &&
      e.result.inserted === 1 &&
      e.result.status === "partial",
  );
  assert.ok(chunks.some((c) => c.content === "new one"));
});
test("legitimate empty and all-existing inputs are distinguished without deleting knowledge", async () => {
  const before = structuredClone(chunks);
  assert.deepEqual(await upsertChunks(A, []), {
    inserted: 0,
    skipped: 0,
    status: "empty",
  });
  assert.deepEqual(await upsertSupplementalChunks(A, []), {
    inserted: 0,
    skipped: 0,
    status: "empty",
  });
  assert.deepEqual(await upsertSupplementalChunks(A, ["owner knowledge"]), {
    inserted: 0,
    skipped: 1,
    status: "skipped",
  });
  assert.deepEqual(chunks, before);
  assert.equal(revision, 7);
});
test("replacement embedding failure never deletes working website or owner knowledge", async () => {
  const before = structuredClone(chunks);
  await assert.rejects(upsertChunks(A, ["new one", "bad embedding"]));
  assert.deepEqual(chunks, before);
  assert.ok(!calls.some((c) => c.q.startsWith("DELETE")));
});
test("replacement database failure rolls back all attempted chunks and revision changes", async () => {
  const before = structuredClone(chunks);
  failContent = "new two";
  await assert.rejects(
    upsertChunks(A, ["new one", "new two"]),
    (e) => e.result.inserted === 0 && e.result.status === "failed",
  );
  assert.deepEqual(chunks, before);
  assert.equal(revision, 7);
});
test("successful replacement changes only the requested business/source after all preparation succeeds", async () => {
  const result = await upsertChunks(A, ["replacement"]);
  assert.equal(result.inserted, 1);
  assert.ok(!chunks.some((c) => c.content === "working website"));
  assert.ok(chunks.some((c) => c.content === "owner knowledge"));
  assert.ok(chunks.some((c) => c.business === "business-b"));
});

test("stale Redis duplicate markers cannot suppress re-upload after knowledge deletion", async () => {
  await upload();
  assert.equal(
    await isDuplicateContent("same retryable upload", "bot-a"),
    true,
  );
  chunks = chunks.filter(
    (c) => c.source !== "owner_upload" || c.business !== A,
  );
  revision++;
  const r = await upload();
  assert.equal(r.status, 200);
  assert.equal(r.body.chunksUpserted, 2);
});

test("queued status is published before worker execution and cannot overwrite fast terminal status", async () => {
  queueMode = "fast-failure";
  const form = new FormData();
  form.append(
    "files",
    new Blob(["file contents"], { type: "text/plain" }),
    "test.txt",
  );
  const r = await fetch(`http://127.0.0.1:${server.address().port}/upsert`, {
    method: "POST",
    body: form,
  });
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.equal(body.queued, true);
  assert.equal(JSON.parse(cache.get(`job:${body.jobIds[0]}`)).status, "failed");
  await fs.unlink(queued[0].filePath);
});
test("ambiguous queue acknowledgement returns non-success and preserves an accepted job source", async () => {
  queueMode = "reject";
  const form = new FormData();
  form.append(
    "files",
    new Blob(["file contents"], { type: "text/plain" }),
    "test.txt",
  );
  const r = await fetch(`http://127.0.0.1:${server.address().port}/upsert`, {
    method: "POST",
    body: form,
  });
  assert.equal(r.status, 503);
  const body = await r.json();
  assert.equal(body.success, false);
  assert.equal(body.acceptanceUnknown, true);
  assert.deepEqual(body.jobIds, [queued[0].jobId]);
  assert.equal(
    JSON.parse(cache.get(`job:${queued[0].jobId}`)).status,
    "queued",
  );
  await fs.access(queued[0].filePath);
  await fs.unlink(queued[0].filePath);
});

test("lost queue acknowledgement cannot overwrite a fast worker terminal status", async () => {
  queueMode = "fast-failure-reject";
  const form = new FormData();
  form.append(
    "files",
    new Blob(["file contents"], { type: "text/plain" }),
    "test.txt",
  );
  const response = await fetch(
    `http://127.0.0.1:${server.address().port}/upsert`,
    { method: "POST", body: form },
  );
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.queued, true);
  assert.equal(JSON.parse(cache.get(`job:${body.jobIds[0]}`)).status, "failed");
  await fs.access(queued[0].filePath);
  await fs.unlink(queued[0].filePath);
});

test("confirmed rejection removes staged bytes and reports failed instead of acceptance ambiguity", async () => {
  queueMode = "confirmed-reject";
  const form = new FormData();
  form.append("files", new Blob(["file contents"]), "test.txt");
  const response = await fetch(
    `http://127.0.0.1:${server.address().port}/upsert`,
    { method: "POST", body: form },
  );
  assert.equal(response.status, 503);
  const body = await response.json();
  assert.equal(body.success, false);
  assert.equal(body.acceptanceUnknown, undefined);
  assert.equal(
    JSON.parse(cache.get(`job:${queued[0].jobId}`)).status,
    "failed",
  );
  await assert.rejects(fs.access(queued[0].filePath));
});
test("persistent queue outage fails before staging or enqueueing any new file", async () => {
  queueMode = "preflight-outage";
  const { uploadDirectory } = await import("../src/services/uploadStaging.js");
  const before = await fs.readdir(uploadDirectory()).catch(() => []);
  const form = new FormData();
  form.append("files", new Blob(["file contents"]), "test.txt");
  const response = await fetch(
    `http://127.0.0.1:${server.address().port}/upsert`,
    { method: "POST", body: form },
  );
  assert.equal(response.status, 503);
  assert.equal(queued.length, 0);
  assert.deepEqual(await fs.readdir(uploadDirectory()).catch(() => []), before);
});
test("confirmed acceptance after lost acknowledgement preserves source and returns pollable job", async () => {
  queueMode = "accepted-reject";
  const form = new FormData();
  form.append("files", new Blob(["file contents"]), "test.txt");
  const response = await fetch(
    `http://127.0.0.1:${server.address().port}/upsert`,
    { method: "POST", body: form },
  );
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.queued, true);
  assert.deepEqual(body.jobIds, [queued[0].jobId]);
  await fs.access(queued[0].filePath);
  await fs.unlink(queued[0].filePath);
});
