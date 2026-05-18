import assert from 'assert';
import { extractDeterministicLeadData } from '../services/leadDetection.js';

const input = "My name is Pastor James, from Grace Church Leeds. My email is james@gracechurchleeds.org and we need a new website with hosting.";
const lead = extractDeterministicLeadData(input);

assert(lead, 'lead should be detected');
assert.equal(lead.name, 'Pastor James');
assert.equal(lead.churchName, 'Grace Church Leeds');
assert.equal(lead.email, 'james@gracechurchleeds.org');
assert.equal(lead.serviceNeed, 'a new website with hosting');
assert.equal(lead.location, 'Leeds');
console.log('leadCaptureDeterministic test passed');
