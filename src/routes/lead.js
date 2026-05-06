import { Router } from 'express';
import { tokenAuth } from '../middleware/tokenAuth.js';
import { leadCaptureTool } from '../tools/leadCaptureTool.js';

const router = Router();

router.post('/capture', tokenAuth, async (req, res) => {
  const { name, email, phone, message, score } = req.body;
  const result = await leadCaptureTool.func({ name, email, phone, message, score: score || 0 });
  res.json({ result });
});

export default router;
