import { Router } from 'express';
import requireAuth from '../middleware/jwtAuth.js';
import {
  createQuickAnswer,
  updateQuickAnswer,
  deleteQuickAnswer,
  listQuickAnswers,
} from '../services/quickAnswers.js';

const router = Router();

router.get('/', requireAuth, async (req, res) => {
  try {
    const rows = await listQuickAnswers({ businessId: req.business.businessId });
    res.json({ quickAnswers: rows });
  } catch (error) {
    console.error('quick_answers_list_failed', { businessId: req.business.businessId, error: error.message });
    res.status(500).json({ error: 'Failed to list quick answers' });
  }
});

router.post('/', requireAuth, async (req, res) => {
  try {
    const { question, answer, category, priority } = req.body;
    if (!question || !answer) return res.status(400).json({ error: 'question and answer are required' });
    const quickAnswer = await createQuickAnswer({ businessId: req.business.businessId, question, answer, category, priority });
    res.status(201).json({ quickAnswer });
  } catch (error) {
    console.error('quick_answer_create_failed', { businessId: req.business.businessId, error: error.message });
    res.status(500).json({ error: 'Failed to create quick answer' });
  }
});

router.patch('/:id', requireAuth, async (req, res) => {
  try {
    const quickAnswer = await updateQuickAnswer({ businessId: req.business.businessId, id: req.params.id, ...req.body });
    if (!quickAnswer) return res.status(404).json({ error: 'Quick answer not found' });
    res.json({ quickAnswer });
  } catch (error) {
    console.error('quick_answer_update_failed', { businessId: req.business.businessId, quickAnswerId: req.params.id, error: error.message });
    res.status(500).json({ error: 'Failed to update quick answer' });
  }
});

router.delete('/:id', requireAuth, async (req, res) => {
  try {
    const deleted = await deleteQuickAnswer({ businessId: req.business.businessId, id: req.params.id });
    if (!deleted) return res.status(404).json({ error: 'Quick answer not found' });
    res.json({ success: true });
  } catch (error) {
    console.error('quick_answer_delete_failed', { businessId: req.business.businessId, quickAnswerId: req.params.id, error: error.message });
    res.status(500).json({ error: 'Failed to delete quick answer' });
  }
});

export default router;
