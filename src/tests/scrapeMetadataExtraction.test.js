import test from 'node:test';
import assert from 'node:assert/strict';

import { parseStarterPromptsResponse } from '../agents/contentGenerator.js';
import {
  deriveNameFromDomain,
  resolveBusinessName,
  resolveLogo,
  sanitizeContactInfo,
  validatePhoneCandidate,
  normalizeIndustry,
  applyFinalConsistency,
} from '../jobs/metadataResolver.js';
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

test('resolveBusinessName derives UK Churches from domain', () => {
  const pages = [
    { url: 'https://ukchurches.co.uk/', title: 'Our Designs', content: '' },
    { url: 'https://ukchurches.co.uk/contact', title: 'Contact', content: '' },
  ];

  assert.equal(
    resolveBusinessName({ pages, aiBusinessName: 'Our Designs', domain: 'https://ukchurches.co.uk' }),
    'UK Churches',
  );
});

test('resolveBusinessName derives Mobius Group from domain', () => {
  const pages = [
    { url: 'https://mobiusgroup.co.uk/', title: 'Building, Renovation & Construction Services', content: '' },
  ];

  assert.equal(
    resolveBusinessName({ pages, aiBusinessName: '', domain: 'https://mobiusgroup.co.uk' }),
    'Mobius Group',
  );
});

test('service heading rejected as business name', () => {
  const pages = [
    { url: 'https://mobiusgroup.co.uk/', title: 'Building, Renovation & Construction Services', content: '' },
  ];

  assert.equal(
    resolveBusinessName({ pages, domain: 'https://mobiusgroup.co.uk' }),
    'Mobius Group',
  );
});

test('resolveBusinessName ignores generic title and uses og:site_name', () => {
  const pages = [
    { url: 'https://ukchurches.example/', title: 'Our Designs', content: 'og:site_name: UK Churches' },
    { url: 'https://ukchurches.example/contact', title: 'Contact', content: '' },
  ];

  assert.equal(
    resolveBusinessName({ pages, aiBusinessName: 'Our Designs', domain: 'https://ukchurches.example' }),
    'UK Churches',
  );
});

test('stale existing business name rejected when domain/content mismatch', () => {
  const pages = [
    { url: 'https://mobiusgroup.co.uk/', title: 'Mobius Group', content: '' },
    { url: 'https://mobiusgroup.co.uk/contact', title: 'Contact', content: '' },
  ];
  assert.equal(
    resolveBusinessName({
      pages,
      existingBusinessName: 'UKChurches',
      aiBusinessName: 'Mobius Group',
      domain: 'https://mobiusgroup.co.uk',
    }),
    'Mobius Group',
  );
});

test('unknown industry corrected from services/text', () => {
  const industry = normalizeIndustry({
    detectedIndustry: 'unknown',
    confidence: 0.2,
    services: ['Church branding'],
    text: 'We offer website design services and hosting',
  });
  assert.equal(industry, 'web_agency');
});

test('random person/content image rejected as logo', () => {
  const pages = [
    {
      url: 'https://ukchurches.co.uk/',
      title: 'UK Churches',
      content: '![Aaron-1a](https://ukchurches.co.uk/images/Aaron-1a-359x1024.jpg "Aaron-1a")',
    },
  ];
  assert.equal(resolveLogo({ pages, domain: 'https://ukchurches.co.uk' }), 'https://ukchurches.co.uk/favicon.ico');
});

test('deborah full-length image rejected as logo and favicon used', () => {
  const pages = [
    {
      url: 'https://ukchurches.co.uk/',
      title: 'UK Churches',
      content: '![Deborah full length](https://ukchurches.co.uk/images/Deborah-full-length-1-285x1024.jpeg "Team photo")',
    },
  ];
  assert.equal(resolveLogo({ pages, domain: 'https://ukchurches.co.uk' }), 'https://ukchurches.co.uk/favicon.ico');
});

test('placeholder phone rejected', () => {
  const contact = sanitizeContactInfo({ extractedPhone: '1234567890', extractedEmail: 'hello@mobiusgroup.co.uk', domain: 'https://mobiusgroup.co.uk' });
  assert.equal(contact.verified.phone, null);
  assert.equal(contact.rejected.phone, '1234567890');
});

test('mobius-style random number is not verified', () => {
  const contact = sanitizeContactInfo({ extractedPhone: '5770906827', extractedEmail: 'hello@mobiusgroup.co.uk', domain: 'https://mobiusgroup.co.uk' });
  assert.equal(contact.verified.phone, null);
  assert.equal(contact.unverified.phone, '5770906827');
});

test('ukchurches number without strong context is not verified', () => {
  const check = validatePhoneCandidate('17624449699', 'homepage body text', { isUkSite: true });
  assert.equal(check.verified, false);
});

test('auto-generated UK placeholder numbers remain unverified', () => {
  const c1 = sanitizeContactInfo({ extractedPhone: '+44 20 7946 0958', extractedEmail: 'hello@mobiusgroup.co.uk', domain: 'https://mobiusgroup.co.uk' });
  const c2 = sanitizeContactInfo({ extractedPhone: '+44 (0)1234 567890', extractedEmail: 'hello@mobiusgroup.co.uk', domain: 'https://mobiusgroup.co.uk' });
  assert.equal(c1.verified.phone, null);
  assert.equal(c2.verified.phone, null);
  assert.equal(c1.unverified.phone, '+44 20 7946 0958');
  assert.equal(c2.rejected.phone, '+44 (0)1234 567890');
});

test('placeholder/example email rejected', () => {
  const contact = sanitizeContactInfo({ extractedPhone: '+1 212 555 1212', extractedEmail: 'test@example.com', domain: 'https://mobiusgroup.co.uk' });
  assert.equal(contact.verified.email, null);
});

test('final consistency rewrites summary/system/welcome to same name', () => {
  const consistent = applyFinalConsistency({
    result: { businessName: 'Buildover', businessSummary: 'Infotec provides services.' },
    welcomeMessage: 'Welcome to Infotec',
    systemPromptDraft: 'You are assistant for Infotec',
    businessName: 'Buildover',
    services: ['construction'],
  });
  assert.equal(consistent.businessName, 'Buildover');
  assert.match(consistent.welcomeMessage, /Buildover/);
  assert.match(consistent.systemPromptDraft, /Buildover/);
});
