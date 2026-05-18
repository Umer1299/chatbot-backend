import assert from 'assert';
import { extractDeterministicLeadData, shouldRunLeadAgent } from '../services/leadDetection.js';

const sarah = "Hi, I’m Sarah Williams from Hope Community Church in Birmingham. My email is sarah@hopechurchbirmingham.org. We already have a website, but it looks outdated and we need help with redesign, hosting, and monthly updates.";
const s = extractDeterministicLeadData(sarah);
assert.equal(s.extracted.fullName, 'Sarah Williams');
assert.equal(s.extracted.email, 'sarah@hopechurchbirmingham.org');
assert.equal(s.extracted.companyName, 'Hope Community Church');
assert.equal(s.extracted.location, 'Birmingham');
assert(/redesign, hosting, and monthly updates/i.test(s.extracted.serviceNeed));
assert.equal(s.extracted.lead_score, 'warm');

const james = "My name is Pastor James, from Grace Church Leeds. My email is james@gracechurchleeds.org and we need a new website with hosting.";
const j = extractDeterministicLeadData(james);
assert.equal(j.extracted.fullName, 'Pastor James');
assert.equal(j.extracted.companyName, 'Grace Church Leeds');
assert.equal(j.extracted.email, 'james@gracechurchleeds.org');
assert.equal(j.extracted.serviceNeed, 'a new website with hosting');

const david = "My name is David Thompson, I’m from Grace Fellowship Manchester. We need a new church website with sermon uploads and events calendar. You can call me on 07123 456789.";
const d = extractDeterministicLeadData(david);
assert.equal(d.extracted.fullName, 'David Thompson');
assert.equal(d.extracted.phone, '07123 456789');
assert.equal(d.extracted.companyName, 'Grace Fellowship Manchester');

assert.equal(shouldRunLeadAgent('Hello', null), false);
const weak = extractDeterministicLeadData('we need website redesign');
assert.equal(shouldRunLeadAgent('we need website redesign', weak), true);
console.log('leadCaptureHybrid test passed');
