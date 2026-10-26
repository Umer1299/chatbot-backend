import 'dotenv/config';
import { isInfraStaging } from './config/infraStaging.js';
import http from 'node:http';
import { assertApprovedStagingSource } from './config/approvedStagingSource.js';

const PORT = process.env.PORT || 3000;
if (isInfraStaging()) assertApprovedStagingSource();
// Verify the immutable approved deployment identity before importing modules
// that can open connections or initialize queues.
const { default: app } = await import(isInfraStaging() ? './infraStagingApp.js' : './app.js');
const { default: pool } = await import('./db/pool.js');
const { redisClient } = await import('./services/redis.js');
const { markApplicationReady } = await import('./services/readiness.js');

const server = http.createServer({ maxHeaderSize: isInfraStaging() ? 8192 : undefined }, app);
if (isInfraStaging()) {
  server.maxConnections = Number(process.env.STAGING_MAX_CONNECTIONS);
  server.requestTimeout = Number(process.env.STAGING_REQUEST_TIMEOUT_MS);
  server.headersTimeout = Math.min(server.requestTimeout, 10000);
}
server.listen(PORT, async () => {
  console.log(`🚀 Server running on port ${PORT}`);
  if (!isInfraStaging()) {
    const { startUploadCleanup } = await import('./services/uploadStaging.js');
    const { fileQueue } = await import('./queues/fileQueue.js');
    startUploadCleanup(fileQueue, redisClient);
  }

  async function initializeNewServices() {
    try {
      if (isInfraStaging()) {
        await pool.query('SELECT 1');
        await redisClient.ping();
        markApplicationReady(true);
        return;
      }
      const { setupVectorTable } = await import('./db/vectorStore.js');
      const { setupSessionHistoryIndexes } = await import('./db/sessionHistory.js');
      const { startScrapeWorker } = await import('./jobs/scrapeWorker.js');
      const { startReminderJobs } = await import('./jobs/paidPlanReminders.js');
      await setupVectorTable();
      console.log('pgvector ready');

      await setupSessionHistoryIndexes();
      console.log('session history indexes ready');

      await redisClient.ping();
      console.log('Redis readiness check passed');

      startScrapeWorker();
      console.log('Scrape worker running');

      startReminderJobs();
      console.log('Reminder jobs scheduled');

      markApplicationReady(true);
      console.log('ChatflowAI services initialized');
    } catch (error) {
      markApplicationReady(false);
      console.error('Startup dependency initialization failed; /readyz remains unavailable', {
        code: error.code || 'INITIALIZATION_FAILED',
      });
    }
  }

  initializeNewServices();
});
