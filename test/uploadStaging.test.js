import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  lookupUploadJob,
  cleanupOrphanUploads,
  holdStagedUpload,
} from "../src/services/uploadStaging.js";

test("staging queue read checks fail within a deadline without enqueueing anything", async () => {
  await assert.rejects(
    lookupUploadJob({ getJob: () => new Promise(() => {}) }, "unused", 5),
    { status: 503 },
  );
});
test("orphan cleanup checks durable queue ownership, age and file type before deletion", async () => {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "chatflow-cleanup-test-"),
  );
  const ids = {
    orphan: randomUUID(),
    active: randomUUID(),
    unknown: randomUUID(),
    young: randomUUID(),
  };
  const file = (id) => path.join(directory, `chatflow-upload-${id}-test.txt`);
  const cache = new Map();
  const redis = {
    get: async (key) => cache.get(key),
    setex: async (key, ttl, value) => cache.set(key, value),
  };
  const queue = { getJob: async (id) => (id === ids.active ? { id } : null) };
  try {
    for (const id of Object.values(ids))
      await fs.writeFile(file(id), "customer upload");
    const old = new Date(Date.now() - 7200000);
    for (const id of [ids.orphan, ids.active, ids.unknown])
      await fs.utimes(file(id), old, old);
    cache.set(
      `job:${ids.orphan}`,
      JSON.stringify({
        status: "queued",
        namespace: "bot-a",
        businessId: "business-a",
      }),
    );
    await fs.writeFile(
      path.join(directory, "unrelated-customer-file.txt"),
      "untouched",
    );
    await fs.symlink(
      path.join(directory, "unrelated-customer-file.txt"),
      path.join(directory, `chatflow-upload-${randomUUID()}-symlink.txt`),
    );
    assert.equal(await cleanupOrphanUploads({ queue, redis, directory }), 2);
    await assert.rejects(fs.access(file(ids.orphan)));
    await assert.rejects(fs.access(file(ids.unknown)));
    await fs.access(file(ids.active));
    await fs.access(file(ids.young));
    await fs.access(path.join(directory, "unrelated-customer-file.txt"));
    assert.deepEqual(JSON.parse(cache.get(`job:${ids.orphan}`)), {
      status: "failed",
      namespace: "bot-a",
      businessId: "business-a",
      error: "Queue submission was not accepted. Please retry.",
    });
    // A restored old source remains protected whenever queue state is uncertain.
    await fs.writeFile(file(ids.unknown), "retained");
    await fs.utimes(file(ids.unknown), old, old);
    assert.equal(
      await cleanupOrphanUploads({
        queue: {
          getJob: async () => {
            throw Error("Redis unavailable");
          },
        },
        redis,
        directory,
      }),
      0,
    );
    await fs.access(file(ids.unknown));
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});
test("bounded rotating scans cannot be permanently blocked by long-lived accepted jobs", async () => {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "chatflow-cleanup-test-"),
  );
  const ids = Array.from({ length: 3 }, () => randomUUID()).sort();
  const names = ids.map((id) => `chatflow-upload-${id}-test.txt`);
  try {
    for (const name of names) {
      await fs.writeFile(path.join(directory, name), "upload");
      const old = new Date(Date.now() - 7200000);
      await fs.utimes(path.join(directory, name), old, old);
    }
    const options = {
      directory,
      maxEntries: 1,
      queue: { getJob: async (id) => (id === ids[2] ? null : { id }) },
      redis: { get: async () => null },
    };
    assert.equal(await cleanupOrphanUploads({ ...options, scanOffset: 0 }), 0);
    assert.equal(await cleanupOrphanUploads({ ...options, scanOffset: 1 }), 0);
    assert.equal(await cleanupOrphanUploads({ ...options, scanOffset: 2 }), 1);
    await fs.access(path.join(directory, names[0]));
    await fs.access(path.join(directory, names[1]));
    await assert.rejects(fs.access(path.join(directory, names[2])));
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("retention never races an enqueue whose write is still pending in this API process", async () => {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "chatflow-cleanup-test-"),
  );
  const id = randomUUID();
  const file = path.join(directory, `chatflow-upload-${id}-test.txt`);
  let release = holdStagedUpload(id);
  try {
    await fs.writeFile(file, "source");
    const old = new Date(Date.now() - 7200000);
    await fs.utimes(file, old, old);
    const options = {
      directory,
      queue: { getJob: async () => null },
      redis: { get: async () => null },
    };
    assert.equal(await cleanupOrphanUploads(options), 0);
    await fs.access(file);
    release();
    assert.equal(await cleanupOrphanUploads(options), 1);
    await assert.rejects(fs.access(file));
  } finally {
    release();
    await fs.rm(directory, { recursive: true, force: true });
  }
});
