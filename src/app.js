

import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import chatRoutes from './routes/chat.js';
import upsertRoutes from './routes/upsert.js';
import chatbotsRoutes from './routes/chatbots.js';
import moderateRoutes from './routes/moderate.js';
import leadRoutes from './routes/lead.js';
import { sessionRateLimiter } from './middleware/rateLimiter.js';
import { tokenAuth } from './middleware/tokenAuth.js';


dotenv.config();
const app = express();
app.use(cors());
app.use(express.json());

app.get('/health', (req, res) => res.send('OK'));
app.get('/ready', (req, res) => res.send('Ready'));

// ❌ REMOVE global auth
// app.use('/api', tokenAuth);

// ✅ Apply rate limit globally (optional)
app.use('/api', sessionRateLimiter);

// ✅ ONLY protect chat
app.use('/api/chat', tokenAuth, chatRoutes);

// ✅ NO TOKEN REQUIRED
app.use('/api/chatbots', chatbotsRoutes);

// other routes (your choice)
app.use('/api/upsert', upsertRoutes);
app.use('/api/moderate', moderateRoutes);
app.use('/api/lead', leadRoutes);

app.use('/api/chat', chatRoutes);
app.use('/api/upsert', upsertRoutes);
app.use('/api/chatbots', chatbotsRoutes);
app.use('/api/moderate', moderateRoutes);
app.use('/api/lead', leadRoutes);

export default app;