import test from 'node:test';
import assert from 'node:assert/strict';

import { parseStarterPromptsResponse } from '../agents/contentGenerator.js';
import {
  deriveNameFromDomain,
  extractBusinessNameFromPages,
  isLikelySameBusinessName,
} from '../jobs/scrapeMetadata.js';
import { extractBrandData, normalizeIndustryFallback } from '../jobs/scrapeHeuristics.js';

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

test('extractBusinessNameFromPages derives UK Churches from domain', () => {
  const pages = [
    { url: 'https://ukchurches.co.uk/', title: 'Our Designs', content: '' },
    { url: 'https://ukchurches.co.uk/contact', title: 'Contact', content: '' },
  ];

  assert.equal(
    extractBusinessNameFromPages(pages, { fallback: 'Our Designs', domain: 'https://ukchurches.co.uk' }),
    'UK Churches',
  );
});

test('extractBusinessNameFromPages derives Mobius Group from domain', () => {
  const pages = [
    { url: 'https://mobiusgroup.co.uk/', title: 'Building, Renovation & Construction Services', content: '' },
  ];

  assert.equal(
    extractBusinessNameFromPages(pages, { fallback: '', domain: 'https://mobiusgroup.co.uk' }),
    'Mobius Group',
  );
});

test('extractBusinessNameFromPages rejects generic marketing title as business name', () => {
  const pages = [
    { url: 'https://mobiusgroup.co.uk/', title: 'Building, Renovation & Construction Services', content: '' },
  ];

  assert.equal(
    extractBusinessNameFromPages(pages, { fallback: '', domain: 'https://mobiusgroup.co.uk' }),
    'Mobius Group',
  );
});

test('extractBusinessNameFromPages ignores generic Our Designs and uses og:site_name', () => {
  const pages = [
    { url: 'https://ukchurches.example/', title: 'Our Designs', content: 'og:site_name: UK Churches' },
    { url: 'https://ukchurches.example/contact', title: 'Contact', content: '' },
  ];

  assert.equal(
    extractBusinessNameFromPages(pages, { fallback: 'Our Designs', domain: 'https://ukchurches.example' }),
    'UK Churches',
  );
});

test('isLikelySameBusinessName rejects cross-domain stale name collisions', () => {
  assert.equal(
    isLikelySameBusinessName('UKChurches', 'Mobius Group', 'Mobius Group'),
    false,
  );
});

test('isLikelySameBusinessName accepts matching variants for same business', () => {
  assert.equal(
    isLikelySameBusinessName('UKChurches', 'UK Churches', 'UK Churches'),
    true,
  );
});

test('cross-domain scrape should prefer current URL name over stale DB name', () => {
  const pages = [
    { url: 'https://mobiusgroup.co.uk/', title: 'Mobius Group', content: '' },
    { url: 'https://mobiusgroup.co.uk/contact', title: 'Contact', content: '' },
  ];
  const domainName = deriveNameFromDomain('https://mobiusgroup.co.uk');
  const prelimScrapedName = extractBusinessNameFromPages(pages, {
    fallback: '',
    domain: 'https://mobiusgroup.co.uk',
  });
  const safeExistingName = isLikelySameBusinessName('UKChurches', domainName, prelimScrapedName)
    ? 'UKChurches'
    : '';

  assert.equal(
    extractBusinessNameFromPages(pages, {
      existingBusinessName: safeExistingName,
      fallback: '',
      domain: 'https://mobiusgroup.co.uk',
    }),
    'Mobius Group',
  );
});

test('stale UKChurches existing name is not used for mobiusgroup.co.uk', () => {
  const pages = [
    { url: 'https://mobiusgroup.co.uk/', title: 'Building, Renovation & Construction Services', content: '' },
  ];

  assert.equal(
    extractBusinessNameFromPages(pages, {
      existingBusinessName: 'UKChurches',
      fallback: 'Mobius Group',
      domain: 'https://mobiusgroup.co.uk',
    }),
    'Mobius Group',
  );
});

test('normalizeIndustryFallback maps unknown website design businesses to web_agency', () => {
  const result = normalizeIndustryFallback(
    { industry: 'unknown', confidence: 0.35, primaryServices: ['Church branding'] },
    'We offer website design services, ministry website solutions, and hosting',
  );

  assert.equal(result.industry, 'web_agency');
  assert.equal(result.confidence >= 0.72, true);
});

test('extractBrandData ignores random content images and falls back to favicon', () => {
  const pages = [
    {
      url: 'https://ukchurches.co.uk/',
      title: 'UK Churches',
      content: '![Aaron-1a](https://ukchurches.co.uk/images/Aaron-1a-359x1024.jpg "Aaron-1a")',
    },
  ];

  const brand = extractBrandData(pages, 'https://ukchurches.co.uk');
  assert.equal(brand.logoUrl, null);
  assert.equal(brand.faviconUrl, 'https://ukchurches.co.uk/favicon.ico');
});
