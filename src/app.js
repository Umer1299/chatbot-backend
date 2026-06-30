import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import rateLimit from 'express-rate-limit';
import RedisStore from 'rate-limit-redis';

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
import { redisClient } from './services/redis.js';
import { globalErrorHandler } from './middleware/errorHandler.js';

dotenv.config();

const app = express();

const allowedOriginsRaw = process.env.WIDGET_ALLOWED_ORIGINS || '';
const allowedOrigins = allowedOriginsRaw
  ? allowedOriginsRaw.split(',').map(s => s.trim()).filter(Boolean)
  : [];

if (process.env.NODE_ENV === 'production' && allowedOrigins.length === 0) {
  console.warn('[CORS] WIDGET_ALLOWED_ORIGINS not set — all origins allowed. Set in Render env vars.');
}

const corsOptions = {
  origin(origin, callback) {
    if (!origin) return callback(null, true);
    if (allowedOrigins.length === 0) return callback(null, true);
    const isAllowed = allowedOrigins.some(a =>
      a.startsWith('*.') ? origin.endsWith(a.slice(2)) : origin === a,
    );
    isAllowed ? callback(null, true) : callback(new Error('CORS: Origin not allowed'));
  },
  credentials: true,
  methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'x-chatbot-token', 'x-admin-key', 'Origin'],
};

const widgetLimiter = rateLimit({
  store: new RedisStore({
    sendCommand: (...args) => redisClient.call(...args),
  }),
  keyGenerator: (req) => {
    const token = req.headers['x-chatbot-token'] || 'anon';
    const ip = req.ip;
    return token + ':' + ip;
  },
  windowMs: 60 * 1000,
  max: 60,
  message: { error: 'Too many requests' },
  standardHeaders: true,
});

const dashboardLimiter = rateLimit({
  store: new RedisStore({
    sendCommand: (...args) => redisClient.call(...args),
  }),
  keyGenerator: (req) => {
    const auth = req.headers.authorization || 'anon';
    const ip = req.ip;
    return auth + ':' + ip;
  },
  windowMs: 60 * 1000,
  max: 120,
  message: { error: 'Too many requests' },
  standardHeaders: true,
});

app.use(cors(corsOptions));
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

app.use('/api/chat', widgetLimiter);
app.use('/api/upsert', widgetLimiter);
app.use('/api/leads', dashboardLimiter);
app.use('/api/inquiries', dashboardLimiter);
app.use('/api/business', dashboardLimiter);
app.use('/api/billing', dashboardLimiter);
app.use('/api/scrape', dashboardLimiter);
app.use('/api/auth', dashboardLimiter);
app.use('/api/quick-answers', dashboardLimiter);
app.use('/api/moderate', widgetLimiter);

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
