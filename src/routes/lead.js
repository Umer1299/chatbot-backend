import { asyncHandler } from '../middleware/asyncHandler.js';
import express from 'express';
import { leadCaptureTool } from '../tools/leadCaptureTool.js';
import { requireAdminKey } from '../middleware/adminAuth.js';
const router = express.Router();
router.post('/capture', requireAdminKey, asyncHandler(async (req, res) => {
  const { name, email, phone, message, score } = req.body;
  const result = await leadCaptureTool.func({ name, email, phone, message, score: score || 0 });
  res.json({ result });
}));
export default router;
