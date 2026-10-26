import express from 'express';
import { configureTrustedProxy } from './middleware/trustedProxy.js';
import { assertInfraStaging, infraStagingConcurrency, infraStagingGate } from './config/infraStaging.js';
import { createReadinessHandler } from './services/readiness.js';
import pool from './db/pool.js';
import { redisClient } from './services/redis.js';

assertInfraStaging();
const app = express();
configureTrustedProxy(app);
app.use(infraStagingConcurrency, infraStagingGate);
app.get('/healthz', (_req, res) => res.send('OK'));
app.get('/readyz', createReadinessHandler({
  checkDatabase: () => pool.query('SELECT 1'),
  checkRedis: () => redisClient.ping(),
}));
export default app;
