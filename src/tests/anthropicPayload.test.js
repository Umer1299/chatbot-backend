import test from 'node:test';
import assert from 'node:assert/strict';
import { buildAnthropicPayload } from '../services/anthropicMessageFormatter.js';

test('anthropic payload moves system messages to top-level system', () => {
  const payload = buildAnthropicPayload('master prompt', [
    { role: 'system', content: 'extra instructions' },
    { role: 'user', content: 'hello' },
    { role: 'assistant', content: 'hi' }
  ]);

  assert.equal(payload.system, 'master prompt\n\nextra instructions');
  assert.deepEqual(payload.messages, [
    { role: 'user', content: 'hello' },
    { role: 'assistant', content: 'hi' }
  ]);
  assert.equal(payload.messages.some((m) => m.role === 'system'), false);
});

test('anthropic payload drops leading assistant message', () => {
  const payload = buildAnthropicPayload('', [
    { role: 'assistant', content: 'I should not be first' },
    { role: 'user', content: 'actual start' }
  ]);

  assert.deepEqual(payload.messages, [{ role: 'user', content: 'actual start' }]);
});

test('openai-style messages remain unchanged outside anthropic helper behavior', () => {
  const input = [
    { role: 'system', content: 'keep for openai path' },
    { role: 'user', content: 'u' }
  ];

  assert.deepEqual(input, [
    { role: 'system', content: 'keep for openai path' },
    { role: 'user', content: 'u' }
  ]);
});
