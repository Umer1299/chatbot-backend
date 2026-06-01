import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const routeSource = await readFile(new URL('../routes/chatbots.js', import.meta.url), 'utf8');
const serviceSource = await readFile(new URL('../services/chatbotDeletion.js', import.meta.url), 'utf8');

test('chatbot delete route delegates full data cleanup', () => {
  assert.match(routeSource, /import \{ deleteChatbotData \} from '\.\.\/services\/chatbotDeletion\.js'/);
  assert.match(routeSource, /router\.delete\('\/:namespace'/);
  assert.match(routeSource, /const result = await deleteChatbotData\(req\.params\.namespace\)/);
  assert.match(routeSource, /res\.json\(\{ success: true, \.\.\.result \}\)/);
});

test('deleteChatbotData removes pgvector chunks and hard-deletes quick answers', () => {
  assert.match(serviceSource, /export async function deleteChatbotData\(namespace\)/);
  assert.match(serviceSource, /deletedChunks = await deleteBusinessChunks\(businessId\)/);
  assert.match(serviceSource, /DELETE FROM quick_answers WHERE business_id = \$1/);
  assert.match(serviceSource, /deletedQuickAnswers = quickAnswerResult\.rowCount/);
});

test('deleteChatbotData removes Redis keys related to the chatbot namespace', () => {
  assert.match(serviceSource, /chatbot:\$\{namespace\}/);
  assert.match(serviceSource, /chatbot_config:\$\{namespace\}/);
  assert.match(serviceSource, /chatbot_namespace_token:\$\{namespace\}/);
  assert.match(serviceSource, /chatbot_token:\$\{token\}/);
  assert.match(serviceSource, /rag:\$\{namespace\}:\*/);
  assert.match(serviceSource, /rag:\$\{businessId\}:\*/);
  assert.match(serviceSource, /lead-extract:\$\{businessId\}:\*/);
  assert.match(serviceSource, /getRedisJobKeysForNamespace\(namespace\)/);
});

test('deleteChatbotDataForBusiness resolves the business bot namespace before cleanup', () => {
  assert.match(serviceSource, /export async function deleteChatbotDataForBusiness\(businessId\)/);
  assert.match(serviceSource, /SELECT bot_id FROM businesses WHERE id = \$1 LIMIT 1/);
  assert.match(serviceSource, /return deleteChatbotData\(namespace\)/);
});
