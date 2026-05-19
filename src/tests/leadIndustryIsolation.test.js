import assert from 'node:assert/strict';
import { buildFinalLeadPayload, checkIndustryDataConsistency, determineLeadMatchStrategy } from '../services/leadConsistency.js';

const rachelLead = {
  id: 'lead-rachel',
  full_name: 'Rachel Adams',
  email: 'rachel@kingswaybaptistoxford.org',
  company_name: 'Kingsway Baptist Oxford',
  industry_data: {
    name: 'Rachel Adams',
    email: 'rachel@kingswaybaptistoxford.org',
    companyName: 'Kingsway Baptist Oxford'
  }
};

const andrewExtracted = {
  fullName: 'Andrew Clarke',
  name: 'Andrew Clarke',
  email: 'andrew@stpetersyork.org.uk',
  companyName: 'St Peters York',
  serviceNeed: 'new website'
};

const mismatchBlocked = Boolean(
  rachelLead.email && andrewExtracted.email
  && rachelLead.email.toLowerCase() !== andrewExtracted.email.toLowerCase()
);
assert.equal(mismatchBlocked, true);

const finalRachel = buildFinalLeadPayload(rachelLead, andrewExtracted, { namespace: 'bot-1' });
assert.equal(finalRachel.email, 'rachel@kingswaybaptistoxford.org');
assert.equal(finalRachel.full_name, 'Rachel Adams');
assert.equal(finalRachel.industry_data.email, 'rachel@kingswaybaptistoxford.org');
assert.equal(finalRachel.industry_data.name, 'Rachel Adams');
assert.equal(checkIndustryDataConsistency(finalRachel), true);

const andrewLead = buildFinalLeadPayload(null, andrewExtracted, { namespace: 'bot-1' });
assert.equal(andrewLead.email, 'andrew@stpetersyork.org.uk');
assert.equal(andrewLead.full_name, 'Andrew Clarke');
assert.equal(andrewLead.industry_data.email, 'andrew@stpetersyork.org.uk');

assert.equal(determineLeadMatchStrategy({ hasEmail: true, hasPhone: true, hasSessionId: true }), 'business_id+email');
assert.equal(determineLeadMatchStrategy({ hasEmail: false, hasPhone: true, hasSessionId: true }), 'business_id+phone');
assert.equal(determineLeadMatchStrategy({ hasEmail: false, hasPhone: false, hasSessionId: true }), 'business_id+session_id');

console.log('leadIndustryIsolation test passed');
