import { Router } from 'express';
import requireAuth from '../middleware/jwtAuth.js';
import {
  createQuickAnswer,
  updateQuickAnswer,
  deleteQuickAnswer,
  deleteQuickAnswerByQuestion,
  listQuickAnswers,
  QuickAnswerEmbeddingError,
} from '../services/quickAnswers.js';

const router = Router();

async function handleQuickAnswerDelete(req, res, { id, question }) {
  if (id) {
    const deleted = await deleteQuickAnswer({ businessId: req.business.businessId, id });
    if (!deleted) return res.status(404).json({ error: 'Quick answer not found' });
    return res.json({ success: true });
  }

  if (question) {
    const deleted = await deleteQuickAnswerByQuestion({ businessId: req.business.businessId, question });
    if (!deleted) return res.status(404).json({ error: 'Quick answer not found' });
    return res.json({ success: true });
  }

  return res.status(400).json({ error: 'id or question is required' });
}

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
    const status = quickAnswer?.inserted ? 201 : 200;
    res.status(status).json({ quickAnswer });
  } catch (error) {
    console.error('quick_answer_create_failed', { businessId: req.business.businessId, error: error.message });
    if (error instanceof QuickAnswerEmbeddingError) {
      return res.status(error.statusCode).json({ error: error.message });
    }
    res.status(500).json({ error: 'Failed to create quick answer' });
  }
});

router.delete('/', requireAuth, async (req, res) => {
  try {
    const id = req.body?.id || req.query?.id;
    const question = req.body?.question || req.query?.question;
    return await handleQuickAnswerDelete(req, res, { id, question });
  } catch (error) {
    console.error('quick_answer_delete_failed', { businessId: req.business.businessId, error: error.message });
    return res.status(500).json({ error: 'Failed to delete quick answer' });
  }
});

router.patch('/:id', requireAuth, async (req, res) => {
  try {
    const quickAnswer = await updateQuickAnswer({ businessId: req.business.businessId, id: req.params.id, ...req.body });
    if (!quickAnswer) return res.status(404).json({ error: 'Quick answer not found' });
    res.json({ quickAnswer });
  } catch (error) {
    console.error('quick_answer_update_failed', { businessId: req.business.businessId, quickAnswerId: req.params.id, error: error.message });
    if (error instanceof QuickAnswerEmbeddingError) {
      return res.status(error.statusCode).json({ error: error.message });
    }
    res.status(500).json({ error: 'Failed to update quick answer' });
  }
});


router.delete('/question', requireAuth, async (req, res) => {
  try {
    const question = req.body?.question || req.query?.question;
    if (!question) return res.status(400).json({ error: 'question is required' });
    return await handleQuickAnswerDelete(req, res, { question });
  } catch (error) {
    console.error('quick_answer_delete_by_question_failed', { businessId: req.business.businessId, error: error.message });
    return res.status(500).json({ error: 'Failed to delete quick answer' });
  }
});

router.delete('/:id', requireAuth, async (req, res) => {
  try {
    return await handleQuickAnswerDelete(req, res, { id: req.params.id });
  } catch (error) {
    console.error('quick_answer_delete_failed', { businessId: req.business.businessId, quickAnswerId: req.params.id, error: error.message });
    return res.status(500).json({ error: 'Failed to delete quick answer' });
  }
});

export default router;
