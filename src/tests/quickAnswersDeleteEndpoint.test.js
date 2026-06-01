import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const routeSource = await readFile(new URL('../api/quickAnswers.js', import.meta.url), 'utf8');
const serviceSource = await readFile(new URL('../services/quickAnswers.js', import.meta.url), 'utf8');

test('quick answers route supports deleting from the collection endpoint', () => {
  assert.match(routeSource, /router\.delete\('\/'/);
  assert.match(routeSource, /const id = req\.body\?\.id \|\| req\.query\?\.id/);
  assert.match(routeSource, /const question = req\.body\?\.question \|\| req\.query\?\.question/);
  assert.match(routeSource, /id or question is required/);
});

test('quick answers route keeps question delete route before id fallback', () => {
  const questionDeleteIndex = routeSource.indexOf("router.delete('/question'");
  const idDeleteIndex = routeSource.indexOf("router.delete('/:id'");

  assert.notEqual(questionDeleteIndex, -1);
  assert.notEqual(idDeleteIndex, -1);
  assert.ok(questionDeleteIndex < idDeleteIndex);
  assert.match(routeSource, /deleteQuickAnswerByQuestion\({ businessId: req\.business\.businessId, question }\)/);
});

test('deleteQuickAnswerByQuestion soft-deletes active quick answers by normalized question', () => {
  assert.match(serviceSource, /export async function deleteQuickAnswerByQuestion/);
  assert.match(serviceSource, /const normalizedQuestion = normalizeQuestion\(question\)/);
  assert.match(serviceSource, /AND normalized_question = \$2/);
  assert.match(serviceSource, /AND is_active = TRUE/);
});
