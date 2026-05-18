import 'dotenv/config';
import app from './app.js';
import { setupVectorTable } from './db/vectorStore.js';
import { startScrapeWorker } from './jobs/scrapeWorker.js';
import { startReminderJobs } from './jobs/followUpReminders.js';
import { redisClient } from './services/redis.js';

const PORT = process.env.PORT || 3000;

process.on('unhandledRejection', (reason) => {
  console.error(JSON.stringify({ event: 'process_unhandled_rejection', message: reason?.message || String(reason) }));
});

process.on('uncaughtException', (error) => {
  console.error(JSON.stringify({ event: 'process_uncaught_exception', message: error?.message || 'unknown_error' }));
});

app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);

  async function initializeNewServices() {
    try {
      await setupVectorTable();
      console.log('pgvector ready');

      try {
        const pong = await redisClient.ping();
        console.log(JSON.stringify({ event: 'redis_connected', ping: pong }));
      } catch (error) {
        console.error(JSON.stringify({ event: 'redis_error', error: error?.message || 'redis_ping_failed' }));
      }

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
