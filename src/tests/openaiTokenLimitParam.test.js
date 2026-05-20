import test from 'node:test';
import assert from 'node:assert/strict';
import { getOpenAITokenLimitParam } from '../services/openaiTokenLimitParam.js';

test('gpt-5-mini uses max_completion_tokens', () => {
  const result = getOpenAITokenLimitParam('gpt-5-mini', 320);
  assert.equal(result.tokenParamName, 'max_completion_tokens');
  assert.deepEqual(result.tokenParam, { max_completion_tokens: 320 });
});

test('gpt-4o-mini uses max_tokens', () => {
  const result = getOpenAITokenLimitParam('gpt-4o-mini', 320);
  assert.equal(result.tokenParamName, 'max_tokens');
  assert.deepEqual(result.tokenParam, { max_tokens: 320 });
});

test('o-series reasoning models use max_completion_tokens', () => {
  const o1 = getOpenAITokenLimitParam('o1-mini', 100);
  const o3 = getOpenAITokenLimitParam('o3', 200);
  const o4 = getOpenAITokenLimitParam('o4-mini', 300);
  assert.equal(o1.tokenParamName, 'max_completion_tokens');
  assert.equal(o3.tokenParamName, 'max_completion_tokens');
  assert.equal(o4.tokenParamName, 'max_completion_tokens');
});
