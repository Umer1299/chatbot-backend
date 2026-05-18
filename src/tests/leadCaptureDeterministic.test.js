import assert from 'assert';
import { extractDeterministicLeadData } from '../services/leadDetection.js';

const input = "My name is Pastor James, from Grace Church Leeds. My email is james@gracechurchleeds.org and we need a new website with hosting.";
const lead = extractDeterministicLeadData(input);

assert(lead, 'lead should be detected');
assert.equal(lead.extracted.name, 'Pastor James');
assert.equal(lead.extracted.churchName, 'Grace Church Leeds');
assert.equal(lead.extracted.email, 'james@gracechurchleeds.org');
assert.equal(lead.extracted.serviceNeed, 'a new website with hosting');
assert.equal(lead.extracted.location, 'Leeds');
console.log('leadCaptureDeterministic test passed');
