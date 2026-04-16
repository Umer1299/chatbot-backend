import express from 'express';
import { moderateInput } from '../services/moderation.js';
const router = express.Router();
router.post('/', async (req, res) => {
  const { text } = req.body;
  if (!text) return res.status(400).json({ error: 'Missing text' });
  res.json(await moderateInput(text));
});
export default router;