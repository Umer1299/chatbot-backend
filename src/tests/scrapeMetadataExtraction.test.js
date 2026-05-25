import test from 'node:test';
import assert from 'node:assert/strict';

import { parseStarterPromptsResponse } from '../agents/contentGenerator.js';
import { extractBusinessNameFromPages } from '../jobs/scrapeMetadata.js';

test('parseStarterPromptsResponse supports object prompt shapes', () => {
  const parsed = [
    { prompt: 'Do you offer emergency callouts?' },
    { question: 'What areas do you serve?' },
    { title: 'How can I book?' },
  ];

  assert.deepEqual(parseStarterPromptsResponse(parsed), [
    'Do you offer emergency callouts?',
    'What areas do you serve?',
    'How can I book?',
  ]);
});

test('parseStarterPromptsResponse falls back when fewer than 3 valid prompts', () => {
  const parsed = ['First question', { text: 'Second question' }, { invalid: true }];
  assert.deepEqual(parseStarterPromptsResponse(parsed), [
    'What services do you offer?',
    'How can I book an appointment?',
    'What are your business hours?',
  ]);
});

test('extractBusinessNameFromPages ignores generic titles and uses og:site_name', () => {
  const pages = [
    { url: 'https://ukchurches.example/', title: 'FAQ', content: 'og:site_name: UK Churches' },
    { url: 'https://ukchurches.example/contact', title: 'Contact', content: '' },
  ];

  assert.equal(
    extractBusinessNameFromPages(pages, { fallback: 'FAQ', domain: 'https://ukchurches.example' }),
    'UK Churches',
  );
});

test('extractBusinessNameFromPages prefers existing business name before generic page titles', () => {
  const pages = [
    { url: 'https://example.org/', title: 'Home', content: '' },
    { url: 'https://example.org/about', title: 'About', content: '' },
  ];

  assert.equal(
    extractBusinessNameFromPages(pages, {
      existingBusinessName: 'Saint Mark Parish',
      fallback: 'Home',
      domain: 'https://example.org',
    }),
    'Saint Mark Parish',
  );
});
