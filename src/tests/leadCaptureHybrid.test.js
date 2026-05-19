import assert from 'assert';
import { extractDeterministicLeadData, shouldRunLeadAgent } from '../services/leadDetection.js';
import { generateProjectDetails } from '../agents/promptBuilder.js';

const sarah = "Hi, I’m Sarah Williams from Hope Community Church in Birmingham. My email is sarah@hopechurchbirmingham.org. We already have a website, but it looks outdated and we need help with redesign, hosting, and monthly updates.";
const s = extractDeterministicLeadData(sarah);
assert.equal(s.extracted.fullName, 'Sarah Williams');
assert.equal(s.extracted.email, 'sarah@hopechurchbirmingham.org');
assert.equal(s.extracted.companyName, 'Hope Community Church');
assert.equal(s.extracted.company_name, 'Hope Community Church');
assert.equal(s.extracted.location, 'Birmingham');
assert(/redesign, hosting, and monthly updates/i.test(s.extracted.serviceNeed));
assert.equal(s.extracted.lead_score, 'hot');
assert.equal(
  generateProjectDetails('web_agency', { ...s.extracted, full_name: s.extracted.fullName }),
  'Industry: web_agency | Name: Sarah Williams | Project Type: website redesign/hosting/management | Needs: redesign, hosting, and monthly updates | Budget: unknown'
);

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

const davidExact = "Hi, this is David Thompson from Grace Fellowship Church in Manchester. We need a new church website with sermon uploads, an events calendar, and online giving. Our current website is very old and we want to launch the new one within 2 months. Our budget is around £1,500–£2,000. You can call me on 07123 456789 or email david@gracefellowshipmanchester.org.";
const dx = extractDeterministicLeadData(davidExact);
assert.equal(dx.extracted.fullName, 'David Thompson');
assert.equal(dx.extracted.phone, '07123 456789');
assert.equal(dx.extracted.email, 'david@gracefellowshipmanchester.org');
assert.equal(dx.extracted.companyName, 'Grace Fellowship Church');
assert.equal(dx.extracted.location, 'Manchester');
assert(/new church website with sermon uploads, an events calendar, and online giving/i.test(dx.extracted.serviceNeed));
assert.equal(dx.extracted.timeline, 'within 2 months');
assert.equal(dx.extracted.budgetRange, '£1,500–£2,000');
assert.equal(dx.extracted.lead_score, 'hot');

assert.equal(shouldRunLeadAgent('Hello', null), false);
const weak = extractDeterministicLeadData('we need website redesign');
assert.equal(shouldRunLeadAgent('we need website redesign', weak), true);


const daniel = "Hi, I’m Daniel Brooks, the youth pastor at New Life Church in Sheffield. Our church website is very outdated, and we need a new modern site that volunteers can easily update. We also want secure hosting, sermon audio uploads, a youth events calendar, online giving, and monthly support. We’d like to launch in the next 6 weeks, and our budget is around £2,200. You can email me at daniel@newlifechurchsheffield.org.uk or call 07845 222 918.";
const dl = extractDeterministicLeadData(daniel);
assert.equal(dl.extracted.fullName, 'Daniel Brooks');
assert.equal(dl.extracted.phone, '07845 222 918');
assert.equal(dl.extracted.email, 'daniel@newlifechurchsheffield.org.uk');
assert.equal(dl.extracted.companyName, 'New Life Church');
assert.equal(dl.extracted.location, 'Sheffield');
assert.equal(dl.extracted.timeline, 'in the next 6 weeks');
assert(/new modern site that volunteers can easily update/i.test(dl.extracted.serviceNeed));
assert(/secure hosting, sermon audio uploads, a youth events calendar, online giving, and monthly support/i.test(dl.extracted.serviceNeed));
assert.equal(
  generateProjectDetails('web_agency', { ...dl.extracted, full_name: dl.extracted.fullName }).includes(`Needs: ${dl.extracted.serviceNeed}`),
  true
);

assert.equal(extractDeterministicLeadData('We need a site and want to launch next 6 weeks').extracted.timeline, 'next 6 weeks');
assert.equal(extractDeterministicLeadData('We need a site and want to launch in the next 6 weeks').extracted.timeline, 'in the next 6 weeks');
assert.equal(extractDeterministicLeadData('We need a site and want to launch within 6 weeks').extracted.timeline, 'within 6 weeks');
assert.equal(extractDeterministicLeadData('We need a site and want to launch within 2 months').extracted.timeline, 'within 2 months');
assert.equal(extractDeterministicLeadData('We need a site and want to launch before Christmas').extracted.timeline.toLowerCase(), 'before christmas');
assert.equal(
  extractDeterministicLeadData('We need a site and we’d like to launch before our September outreach event.').extracted.timeline,
  'before our September outreach event'
);
assert.equal(extractDeterministicLeadData('We need a site as soon as possible').extracted.timeline.toLowerCase(), 'as soon as possible');

console.log('leadCaptureHybrid test passed');
