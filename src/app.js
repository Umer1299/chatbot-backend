import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';

import chatRoutes from './routes/chat.js';
import upsertRoutes from './routes/upsert.js';
import chatbotsRoutes from './routes/chatbots.js';
import moderateRoutes from './routes/moderate.js';
import leadRoutes from './routes/lead.js';
import { sessionRateLimiter } from './middleware/rateLimiter.js';

dotenv.config();

const app = express();

const allowedWidgetOrigins = (process.env.WIDGET_ALLOWED_ORIGINS || '')
  .split(',')
  .map(origin => origin.trim())
  .filter(Boolean);

app.use(cors({
  origin(origin, callback) {
    if (!origin) return callback(null, true);
    if (allowedWidgetOrigins.length === 0) return callback(null, true);
    if (allowedWidgetOrigins.includes(origin)) return callback(null, true);
    return callback(new Error('Not allowed by CORS'));
  },
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'x-chatbot-token'],
}));
app.use(express.json());

app.get('/health', (req, res) => res.send('OK'));
app.get('/healthz', (req, res) => res.send('OK'));
app.get('/ready', (req, res) => res.send('Ready'));
app.get('/readyz', (req, res) => res.send('Ready'));

app.use('/api', sessionRateLimiter);

app.use('/api/chat', chatRoutes);
app.use('/api/upsert', upsertRoutes);
app.use('/api/chatbots', chatbotsRoutes);
app.use('/api/moderate', moderateRoutes);
app.use('/api/lead', leadRoutes);

export default app;
