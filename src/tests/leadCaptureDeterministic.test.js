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

const michaelPrompt = "Hi, my name is Michael Evans and I’m the operations manager at Riverside Community Church in Liverpool. We’re looking for help because our current church website is outdated and hard for volunteers to manage. We need a redesign, secure hosting, sermon video uploads, an events calendar, online donations, and someone to handle monthly updates for us. We’d like to launch within 8 weeks if possible. Our budget is around £3,000. You can reach me at michael@riversidechurchliverpool.org.uk or call me on 07788 456 321.";
const michaelLead = extractDeterministicLeadData(michaelPrompt).extracted;
assert.equal(michaelLead.fullName, 'Michael Evans');
assert.equal(michaelLead.companyName, 'Riverside Community Church');
assert.equal(michaelLead.company_name, 'Riverside Community Church');
assert.equal(michaelLead.churchName, 'Riverside Community Church');
assert.equal(michaelLead.location, 'Liverpool');
assert.equal(michaelLead.serviceNeed, 'a redesign, secure hosting, sermon video uploads, an events calendar, online donations, and someone to handle monthly updates for us');
console.log('leadCaptureDeterministic Michael extraction passed');
