import 'dotenv/config';
import app from './app.js';
import { setupVectorTable } from './db/vectorStore.js';
import { startScrapeWorker } from './jobs/scrapeWorker.js';
import { startReminderJobs } from './jobs/followUpReminders.js';

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);

  async function initializeNewServices() {
    try {
      await setupVectorTable();
      console.log('pgvector ready');

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
