import 'dotenv/config';
import app from './app.js';
import { setupVectorTable } from './db/vectorStore.js';
import { setupSessionHistoryIndexes } from './db/sessionHistory.js';
import { startScrapeWorker } from './jobs/scrapeWorker.js';
import { startReminderJobs } from './jobs/paidPlanReminders.js';
import { startUploadCleanup } from './services/uploadStaging.js';
import { fileQueue } from './queues/fileQueue.js';
import { redisClient } from './services/redis.js';
import { markApplicationReady } from './services/readiness.js';

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  startUploadCleanup(fileQueue, redisClient);

  async function initializeNewServices() {
    try {
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
