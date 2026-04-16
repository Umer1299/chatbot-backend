import { Queue } from 'bullmq';
import { connection } from './connection.js';

export const fileQueue = new Queue('file-processing', {
  connection,
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: 'exponential', delay: 5000 },
    removeOnComplete: true,
    removeOnFail: false,
  },
});