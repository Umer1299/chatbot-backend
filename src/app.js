import express from 'express';
import cors from 'cors';
import { createCorsPolicy } from './middleware/corsPolicy.js';
import dotenv from 'dotenv';
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

dotenv.config();

const app = express();

const corsPolicy = createCorsPolicy({
  widgetOriginsRaw: process.env.WIDGET_ALLOWED_ORIGINS || '',
  dashboardOriginsRaw: process.env.DASHBOARD_ALLOWED_ORIGINS,
});

function authenticatedManagementQuota(req, res, next) {
  return requireAuth(req, res, () => dashboardLimiter(req, res, next));
}

app.use(cors(corsPolicy));
app.use(express.json());

app.get('/health', (req, res) => res.send('OK'));
app.get('/healthz', (req, res) => res.send('OK'));
app.get('/ready', (req, res) => res.send('Ready'));
app.get('/readyz', (req, res) => res.send('Ready'));

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

app.use(globalErrorHandler);

export default app;
