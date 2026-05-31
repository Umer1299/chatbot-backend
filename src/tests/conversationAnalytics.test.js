import test from 'node:test';
import assert from 'node:assert/strict';

import { checkIfUnanswered, detectIntentCategory } from '../services/conversationAnalytics.js';

test('marks out-of-scope specialization replies as unanswered for weekly failed questions', () => {
  const reply = `I think there might be some confusion — we specialise in **church websites**, not physical items like swings.

We help churches with website design and hosting.`;

  assert.equal(checkIfUnanswered(reply, 'church website design and hosting'), true);
});

test('classifies broad can-you requests without service keywords as generic', () => {
  assert.equal(detectIntentCategory('can you create me a swing?'), 'generic');
});

test('keeps concrete service requests classified as services', () => {
  assert.equal(detectIntentCategory('Can you install flooring in a church hall?'), 'services');
});
