import requireAuth from './jwtAuth.js';

// Knowledge is a dashboard capability, never a public widget capability.
export function requireKnowledgeOwner(req, res, next) {
  return requireAuth(req, res, () => {
    if (!req.business.botId) return res.status(403).json({ error: 'Bot unavailable' });
    if (req.params.namespace && req.params.namespace !== req.business.botId) {
      return res.status(403).json({ error: 'Invalid bot scope' });
    }
    req.namespace = req.business.botId;
    return next();
  });
}
