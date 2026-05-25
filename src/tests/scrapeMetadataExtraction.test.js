import test from 'node:test';
import assert from 'node:assert/strict';

import { parseStarterPromptsResponse } from '../agents/contentGenerator.js';

test('parseStarterPromptsResponse supports object and nested object prompt shapes', () => {
  const parsed = [
    { prompt: { text: 'Do you offer emergency callouts?' } },
    { question: 'What areas do you serve?' },
    [{ label: 'How can I book?' }],
    { content: '[object Object]' },
  ];

  assert.deepEqual(parseStarterPromptsResponse(parsed, { industry: 'web_agency' }), [
    'Do you offer emergency callouts?',
    'What areas do you serve?',
    'How can I book?',
  ]);
});

test('parseStarterPromptsResponse fills missing prompts with contextual fallbacks', () => {
  const parsed = [{ text: 'Tell me about your branding work' }];
  assert.deepEqual(parseStarterPromptsResponse(parsed, { industry: 'web_agency', primaryServices: ['Church website design'] }), [
    'Tell me about your branding work',
    'Can you tell me more about your Church website design services?',
    'Do you build church websites or ministry-focused websites?',
  ]);
});
