import test from 'node:test';
import assert from 'node:assert/strict';

import {
  resolveBusinessName,
  resolveLogo,
  sanitizeContactInfo,
  validatePhoneCandidate,
} from '../jobs/metadataResolver.js';

test('regression/name: ukchurches.co.uk does not resolve to FAQ or Our Designs', () => {
  const pages = [
    { url: 'https://ukchurches.co.uk/', title: 'Our Designs', content: '' },
    { url: 'https://ukchurches.co.uk/faq', title: 'FAQ', content: '' },
  ];

  const resolved = resolveBusinessName({ pages, aiBusinessName: 'Our Designs', domain: 'https://ukchurches.co.uk' });
  assert.equal(resolved, 'UK Churches');
  assert.notEqual(resolved, 'FAQ');
  assert.notEqual(resolved, 'Our Designs');
});

test('regression/name: mobiusgroup.co.uk does not resolve to UKChurches or service heading', () => {
  const pages = [
    { url: 'https://mobiusgroup.co.uk/', title: 'Building, Renovation & Construction Services', content: '' },
  ];

  const resolved = resolveBusinessName({ pages, domain: 'https://mobiusgroup.co.uk' });
  assert.equal(resolved, 'Mobius Group');
  assert.notEqual(resolved, 'UKChurches');
  assert.notEqual(resolved, 'Building, Renovation & Construction Services');
});

test('regression/name: buildover.co.uk does not create slash-combined final name unless verified', () => {
  const pages = [
    { url: 'https://buildover.co.uk/', title: 'Buildover / Infotec', content: '' },
  ];

  const resolved = resolveBusinessName({ pages, aiBusinessName: '', domain: 'https://buildover.co.uk' });
  assert.equal(resolved, 'Buildover');
  assert.doesNotMatch(resolved, /\//);
});

test('regression/logo: Deborah/Aaron content images are rejected as logos', () => {
  const pages = [
    {
      url: 'https://ukchurches.co.uk/',
      title: 'UK Churches',
      content: [
        '![Aaron-1a](https://ukchurches.co.uk/images/Aaron-1a-359x1024.jpg "Aaron-1a")',
        '![Deborah full length](https://ukchurches.co.uk/images/Deborah-full-length-1-285x1024.jpeg "Team photo")',
      ].join('\n'),
    },
  ];

  assert.equal(resolveLogo({ pages, domain: 'https://ukchurches.co.uk' }), 'https://ukchurches.co.uk/favicon.ico');
});

test('regression/contact: info@yourchurch.com is rejected', () => {
  const contact = sanitizeContactInfo({
    extractedPhone: '+44 20 7946 0958',
    extractedEmail: 'info@yourchurch.com',
    domain: 'https://ukchurches.co.uk',
  });

  assert.equal(contact.verified.email, null);
});

test('regression/contact: 5770906827 and 17624449699 are not verified without strong context', () => {
  const mobiusStyle = sanitizeContactInfo({
    extractedPhone: '5770906827',
    extractedEmail: 'hello@mobiusgroup.co.uk',
    domain: 'https://mobiusgroup.co.uk',
  });
  const ukchurchesStyle = validatePhoneCandidate('17624449699', 'homepage body text', { isUkSite: true });

  assert.equal(mobiusStyle.verified.phone, null);
  assert.equal(mobiusStyle.unverified.phone, '5770906827');
  assert.equal(ukchurchesStyle.verified, false);
});
