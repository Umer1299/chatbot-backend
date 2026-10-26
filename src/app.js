import express from 'express';
import cors from 'cors';
import { createCorsPolicy } from './middleware/corsPolicy.js';
import { configureTrustedProxy } from './middleware/trustedProxy.js';
import { assertInfraStaging, infraStagingGate, infraStagingConcurrency } from './config/infraStaging.js';
import dotenv from 'dotenv';
import { accountHandler, accountIdentity } from './middleware/accountAuth.js';
import agenciesV1 from './api/agenciesV1.js';
import agentsV1 from './api/agentsV1.js';
import agentRuntimeV1 from './api/agentRuntimeV1.js';
import agentChat from './api/agentChat.js';
import { accountIpLimiter, accountLookupLimiter, accountUserLimiter, agentChatIpLimiter } from './middleware/rateLimiter.js';
import { authRateLimiter, publicReadLimiter, adminRateLimiter, widgetLimiter, dashboardLimiter } from './middleware/rateLimiter.js';
import requireAuth from './middleware/jwtAuth.js';
import { tokenAuth } from './middleware/tokenAuth.js';
import { requireAdminKey } from './middleware/adminAuth.js';

import './agents/registerSaasSoftware.js';
import './agents/registerUniversalContactRouter.js';
import chatRoutes from './routes/chat.js';
import upsertRoutes from './routes/upsert.js';
import chatbotsRoutes from './routes/chatbots.js';
import moderateRoutes from './routes/moderate.js';
import leadRoutes from './routes/lead.js';
import authRoutes from './api/auth.js';
import billingRoutes from './api/billing.js';
import scrapeRoutes from './api/scrape.js';
import leadsRoutes from './api/leads.js';
import inquiriesRoutes from './api/inquiries.js';
import businessRoutes from './api/businessPublic.js';
import quickAnswersRoutes from './api/quickAnswers.js';
import { globalErrorHandler } from './middleware/errorHandler.js';
import { createReadinessHandler } from './services/readiness.js';
import pool from './db/pool.js';
import { redisClient } from './services/redis.js';

dotenv.config();

const app = express();
assertInfraStaging();
configureTrustedProxy(app);
app.use(infraStagingConcurrency);
app.use(infraStagingGate);

const corsPolicy = createCorsPolicy({
  widgetOriginsRaw: process.env.WIDGET_ALLOWED_ORIGINS || '',
  dashboardOriginsRaw: process.env.DASHBOARD_ALLOWED_ORIGINS,
});

function authenticatedManagementQuota(req, res, next) {
  return requireAuth(req, res, () => dashboardLimiter(req, res, next));
}

app.use(cors(corsPolicy));
// Better Auth consumes the raw stream; mount before the JSON parser.
app.all('/api/account/*', accountIpLimiter, accountHandler());
app.use(express.json());
app.use('/api/v1', accountLookupLimiter, accountIdentity(), accountUserLimiter, agenciesV1, agentsV1, agentRuntimeV1);

app.get('/health', (req, res) => res.send('OK'));
app.get('/healthz', (req, res) => res.send('OK'));
app.get('/ready', (req, res) => res.send('Ready'));
app.get('/readyz', createReadinessHandler({
  checkDatabase: () => pool.query('SELECT 1'),
  checkRedis: () => redisClient.ping(),
}));

app.get('/billing/select-plan', (req, res) => {
  const frontendUrl = process.env.BUBBLE_APP_URL || process.env.FRONTEND_URL;
  if (!frontendUrl) {
    return res.status(404).json({ error: 'Billing page is not hosted by this API. Set BUBBLE_APP_URL or FRONTEND_URL to enable redirect.' });
  }
  const base = frontendUrl.replace(/\/+$/, '');
  const query = req.originalUrl.includes('?') ? req.originalUrl.slice(req.originalUrl.indexOf('?')) : '';
  return res.redirect(302, `${base}/billing/select-plan${query}`);
});

app.use('/api/chat', tokenAuth, widgetLimiter);
app.use('/api/agent-chat', agentChatIpLimiter, agentChat);
app.use('/api/upsert', authenticatedManagementQuota);
app.use('/api/leads', authenticatedManagementQuota);
app.use('/api/inquiries', authenticatedManagementQuota);
// Existing preview exposes only public widget presentation fields.
app.use('/api/business', (req, res, next) => {
  if (['GET', 'HEAD'].includes(req.method) && /^\/bot-config\/[^/]+\/preview\/?$/.test(req.path)) {
    return publicReadLimiter(req, res, next);
  }
  return authenticatedManagementQuota(req, res, next);
});
app.use('/api/billing', authenticatedManagementQuota);
app.use('/api/scrape', authenticatedManagementQuota);
app.use('/api/auth', authRateLimiter);
app.use('/api/quick-answers', authenticatedManagementQuota);
app.use('/api/moderate', tokenAuth, widgetLimiter);
app.use('/api/chatbots', requireAdminKey, adminRateLimiter);
app.use('/api/lead', requireAdminKey, adminRateLimiter);

app.use('/api/chat', chatRoutes);
app.use('/api/upsert', upsertRoutes);
app.use('/api/chatbots', chatbotsRoutes);
app.use('/api/moderate', moderateRoutes);
app.use('/api/lead', leadRoutes);
app.use('/api/auth', authRoutes);
app.use('/api/billing', billingRoutes);
app.use('/api/scrape', scrapeRoutes);
app.use('/api/leads', leadsRoutes);
app.use('/api/inquiries', inquiriesRoutes);
app.use('/api/business', businessRoutes);
app.use('/api/quick-answers', quickAnswersRoutes);

app.use((error, req, res, next) => {
  if (!/^\/api\/(account|v1)(\/|$)/.test(req.path) || res.headersSent) return next(error);
  const status = [400,401,403,404,409,415,429,503].includes(error.status) ? error.status : 500;
  res.status(status).json({ error: status === 500 ? 'Account operation failed' : status === 503 ? 'Account service unavailable' : status === 404 ? 'Resource not found' : status === 409 ? 'Operation conflicts with current state' : status === 400 ? 'Invalid request' : status === 401 ? 'Authentication required' : 'Request not permitted' });
});
app.use(globalErrorHandler);

export default app;
