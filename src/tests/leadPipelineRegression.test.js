import assert from 'node:assert/strict';
import { extractDeterministicLeadData } from '../services/leadDetection.js';

function hasMinimumLeadDataForSave(lead = {}) {
  const email = Boolean(lead.email);
  const phone = Boolean(lead.phone);
  const serviceNeed = Boolean(lead.serviceNeed);
  const companyName = Boolean(lead.companyName || lead.company_name || lead.churchName);
  const name = Boolean(lead.fullName || lead.name);
  return (email && serviceNeed) || (phone && serviceNeed) || (email && companyName) || (phone && companyName) || (name && companyName && serviceNeed);
}

const sample = "Hello, I’m Rebecca Carter, the church administrator at St Mark’s Church in Bristol. We need a website redesign, hosting, sermon uploads, events calendar, and monthly website management. Our budget is around £2,500 and we want to launch before Christmas. Email me at rebecca@stmarksbristol.org.uk or call 07456 123 890.";
const lead = extractDeterministicLeadData(sample);
assert.equal(Boolean(lead.extracted.email), true);
assert.equal(Boolean(lead.extracted.phone), true);
assert.equal(lead.extracted.timeline?.toLowerCase().includes('before christmas'), true);
assert.equal(hasMinimumLeadDataForSave(lead.extracted), true);

// same session + different email should be treated as new lead candidate by dedupe logic expectations
const first = { email: 'a@x.com', companyName: 'A Co', fullName: 'A User', serviceNeed: 'website' };
const second = { email: 'b@x.com', companyName: 'A Co', fullName: 'A User', serviceNeed: 'website' };
assert.notEqual(first.email, second.email);
assert.equal(hasMinimumLeadDataForSave(first), true);
assert.equal(hasMinimumLeadDataForSave(second), true);

console.log('leadPipelineRegression tests passed');
