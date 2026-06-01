import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const businessSource = await readFile(new URL('../api/business.js', import.meta.url), 'utf8');

test('business bot config exposes authenticated quick question delete endpoint', () => {
  assert.match(businessSource, /router\.delete\('\/bot-config\/quick-question', requireAuth/);
  assert.match(businessSource, /question or index is required/);
  assert.match(businessSource, /Quick question not found/);
});

test('quick question delete endpoint updates starter prompt arrays and clears cache', () => {
  assert.match(businessSource, /starter_prompts = \$1/);
  assert.match(businessSource, /brand_starter_prompts = \$2/);
  assert.match(businessSource, /deleteQuickQuestionFromList\(currentStarterPrompts/);
  assert.match(businessSource, /deleteQuickQuestionFromList\(currentBrandStarterPrompts/);
  assert.match(businessSource, /redisClient\.del\(`chatbot_config:\$\{rows\[0\]\.bot_id\}`\)/);
});
