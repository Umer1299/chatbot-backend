import test from 'node:test';
import assert from 'node:assert/strict';

import {
  resolveBusinessName,
  resolveLogo,
  sanitizeContactInfo,
  normalizeIndustry,
  applyFinalConsistency,
} from '../jobs/metadataResolver.js';

test('generic/domain: alpha-engineering.co.uk resolves to Alpha Engineering', () => {
  const pages = [
    { url: 'https://alpha-engineering.co.uk/', title: 'Home', content: '' },
  ];

  assert.equal(
    resolveBusinessName({ pages, aiBusinessName: 'Home', domain: 'https://alpha-engineering.co.uk' }),
    'Alpha Engineering',
  );
});

test('generic/domain: acmegroup.co.uk resolves to Acme Group', () => {
  const pages = [
    { url: 'https://acmegroup.co.uk/', title: 'Welcome', content: '' },
  ];

  assert.equal(resolveBusinessName({ pages, domain: 'https://acmegroup.co.uk' }), 'Acme Group');
});

test('generic/domain: northstarservices.com resolves to Northstar Services', () => {
  const pages = [
    { url: 'https://northstarservices.com/', title: 'Services', content: '' },
  ];

  assert.equal(resolveBusinessName({ pages, domain: 'https://northstarservices.com' }), 'Northstar Services');
});

test('generic/domain: brightchurches.org resolves to Bright Churches', () => {
  const pages = [
    { url: 'https://brightchurches.org/', title: 'Our Work', content: '' },
  ];

  assert.equal(resolveBusinessName({ pages, domain: 'https://brightchurches.org' }), 'Bright Churches');
});

test('generic/name: service heading rejected as business name', () => {
  const pages = [
    { url: 'https://northstarservices.com/', title: 'Building, Renovation & Construction Services', content: '' },
  ];

  assert.equal(resolveBusinessName({ pages, domain: 'https://northstarservices.com' }), 'Northstar Services');
});

test('generic/name: stale existing business name rejected when current domain/content differs', () => {
  const pages = [
    { url: 'https://acmegroup.co.uk/', title: 'Acme Group', content: '' },
    { url: 'https://acmegroup.co.uk/contact', title: 'Contact', content: '' },
  ];

  assert.equal(
    resolveBusinessName({
      pages,
      existingBusinessName: 'Bright Churches',
      aiBusinessName: 'Acme Group',
      domain: 'https://acmegroup.co.uk',
    }),
    'Acme Group',
  );
});

test('generic/contact: placeholder phone rejected', () => {
  const contact = sanitizeContactInfo({
    extractedPhone: '1234567890',
    extractedEmail: 'hello@acmegroup.co.uk',
    domain: 'https://acmegroup.co.uk',
  });

  assert.equal(contact.verified.phone, null);
  assert.equal(contact.rejected.phone, '1234567890');
});

test('generic/logo: random content image rejected as logo', () => {
  const pages = [
    {
      url: 'https://brightchurches.org/',
      title: 'Bright Churches',
      content: '![Random profile](https://brightchurches.org/images/profile-hero-1-350x900.jpg "Profile")',
    },
  ];

  assert.equal(resolveLogo({ pages, domain: 'https://brightchurches.org' }), 'https://brightchurches.org/favicon.ico');
});

test('generic/contact: example/demo email rejected', () => {
  const example = sanitizeContactInfo({
    extractedPhone: '+1 212 555 1212',
    extractedEmail: 'test@example.com',
    domain: 'https://acmegroup.co.uk',
  });

  const demo = sanitizeContactInfo({
    extractedPhone: '+1 212 555 1212',
    extractedEmail: 'sales@demo.com',
    domain: 'https://acmegroup.co.uk',
  });

  assert.equal(example.verified.email, null);
  assert.equal(demo.verified.email, null);
});

test('generic/industry: unknown industry corrected from generic service keywords', () => {
  const industry = normalizeIndustry({
    detectedIndustry: 'unknown',
    confidence: 0.2,
    services: ['Website redesign', 'Hosting support'],
    text: 'We offer website design services and hosting support for local businesses',
  });

  assert.equal(industry, 'web_agency');
});

test('generic/consistency: final consistency uses one canonical businessName across output text', () => {
  const consistent = applyFinalConsistency({
    result: { businessName: 'Northstar Services', businessSummary: 'Acme Group provides services.' },
    welcomeMessage: 'Welcome to Acme Group',
    systemPromptDraft: 'You are assistant for Acme Group',
    businessName: 'Northstar Services',
    services: ['consulting'],
  });

  assert.equal(consistent.businessName, 'Northstar Services');
  assert.match(consistent.welcomeMessage, /Northstar Services/);
  assert.match(consistent.systemPromptDraft, /Northstar Services/);
});
