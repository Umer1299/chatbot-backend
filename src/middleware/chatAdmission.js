import { Router } from 'express';
import { tokenAuth } from './tokenAuth.js';
import { domainRestriction } from './domainRestriction.js';
import { requireChatSession } from './chatSession.js';

// Only this module can attest admission. Request headers/body cannot supply it.
// A policy/token change affects the next request, not a second check after writes.
const admitted = new WeakSet();
const gate = Router();
gate.use(tokenAuth, domainRestriction, requireChatSession, (req, res, next) => {
  admitted.add(req);
  next();
});
export function chatAdmission(req, res, next) {
  if (admitted.has(req)) return next();
  return gate(req, res, next);
}
