import 'dotenv/config';
import app from './app.js';
import { setupVectorTable } from './db/vectorStore.js';
import { setupSessionHistoryIndexes } from './db/sessionHistory.js';
import { startScrapeWorker } from './jobs/scrapeWorker.js';
import { startReminderJobs } from './jobs/paidPlanReminders.js';
import { startUploadCleanup } from './services/uploadStaging.js';
import { fileQueue } from './queues/fileQueue.js';
import { redisClient } from './services/redis.js';

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

      startScrapeWorker();
      console.log('Scrape worker running');

      startReminderJobs();
      console.log('Reminder jobs scheduled');

      console.log('ChatflowAI services initialized');
    } catch (error) {
      console.error(`Initialization error: ${error.message}`);
    }
  }

  initializeNewServices();
});
