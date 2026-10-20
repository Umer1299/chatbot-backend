import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

export const uploadDirectory = () =>
  path.join(os.tmpdir(), "chatflow-upload-staging");
const pendingUploads = new Set();
export function holdStagedUpload(jobId) {
  pendingUploads.add(jobId);
  return () => pendingUploads.delete(jobId);
}
const queueUnavailable = () =>
  Object.assign(new Error("File queue unavailable"), { status: 503 });

// Bound only read operations. Never timeout an enqueue and then mistake its
// still-pending write for a confirmed rejection.
export async function lookupUploadJob(queue, id, timeoutMs = 3000) {
  let timer;
  try {
    return await Promise.race([
      queue.getJob(id),
      new Promise((resolve, reject) => {
        timer = setTimeout(() => reject(queueUnavailable()), timeoutMs);
      }),
    ]);
  } catch {
    throw queueUnavailable();
  } finally {
    clearTimeout(timer);
  }
}

export async function stageUpload(file, jobId) {
  const directory = uploadDirectory();
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const filePath = path.join(
    directory,
    `chatflow-upload-${jobId}-${path.basename(file.originalname)}`,
  );
  const handle = await fs.open(filePath, "wx", 0o600);
  try {
    await handle.writeFile(file.buffer);
  } catch (error) {
    await fs.unlink(filePath).catch(() => {});
    throw error;
  } finally {
    await handle.close();
  }
  return filePath;
}

export async function enqueueOutcome(queue, redis, jobId) {
  try {
    if (await lookupUploadJob(queue, jobId)) return "accepted";
    // Completed jobs may already have been removed from BullMQ. Preserve their
    // terminal polling result instead of overwriting it with a request failure.
    const raw = await redis.get(`job:${jobId}`);
    if (raw && ["completed", "failed"].includes(JSON.parse(raw).status))
      return "accepted";
    return "rejected";
  } catch {
    return "unknown";
  }
}

export async function cleanupOrphanUploads({
  queue,
  redis,
  directory = uploadDirectory(),
  now = Date.now(),
  minAgeMs = 3600000,
  maxEntries = 100,
  scanOffset = 0,
} = {}) {
  let entries;
  try {
    entries = await fs.readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") return 0;
    throw error;
  }
  entries.sort((a, b) => a.name.localeCompare(b.name));
  const offset = entries.length ? scanOffset % entries.length : 0;
  entries = [...entries.slice(offset), ...entries.slice(0, offset)];
  let checked = 0,
    removed = 0;
  for (const entry of entries) {
    const match =
      /^chatflow-upload-([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})-/.exec(
        entry.name,
      );
    if (!entry.isFile() || !match || pendingUploads.has(match[1])) continue;
    const filePath = path.join(directory, entry.name);
    const stat = await fs.lstat(filePath).catch(() => null);
    if (!stat?.isFile() || now - stat.mtimeMs < minAgeMs) continue;
    if (checked++ >= maxEntries) break;
    // On any uncertainty preserve bytes. Preflight stops new staging during
    // persistent queue outages, while the next healthy scan reclaims orphans.
    let job;
    try {
      job = await lookupUploadJob(queue, match[1]);
    } catch {
      break;
    }
    if (job) continue;
    const raw = await redis.get(`job:${match[1]}`).catch(() => null);
    if (raw) {
      let status;
      try {
        status = JSON.parse(raw);
      } catch {
        continue;
      }
      if (status.status === "queued")
        await redis
          .setex(
            `job:${match[1]}`,
            86400,
            JSON.stringify({
              ...status,
              status: "failed",
              error: "Queue submission was not accepted. Please retry.",
            }),
          )
          .catch(() => {});
    }
    await fs.unlink(filePath).catch((error) => {
      if (error.code !== "ENOENT") throw error;
    });
    removed++;
  }
  return removed;
}

export function startUploadCleanup(queue, redis) {
  let running = false,
    cursor = 0;
  const run = async () => {
    if (running) return;
    running = true;
    try {
      await cleanupOrphanUploads({ queue, redis, scanOffset: cursor });
      cursor += 100;
    } catch {
      console.error("Upload staging cleanup unavailable");
    } finally {
      running = false;
    }
  };
  void run();
  const timer = setInterval(run, 600000);
  timer.unref();
  return () => clearInterval(timer);
}
