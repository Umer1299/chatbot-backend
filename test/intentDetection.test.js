import test from 'node:test';
import assert from 'node:assert/strict';
import { detectMessageIntent } from '../src/services/intentDetection.js';

test('simple intents remain simple', () => {
  assert.equal(detectMessageIntent('Hi', 'web_agency', {}).shouldUseSimpleReply, true);
  assert.equal(detectMessageIntent('Thanks', 'web_agency', {}).shouldUseSimpleReply, true);
  assert.equal(detectMessageIntent('Bye', 'web_agency', {}).shouldUseSimpleReply, true);
});

test('long request starting with greeting is not simple', () => {
  const result = detectMessageIntent('Hi we need a website', 'web_agency', {});
  assert.equal(result.shouldUseSimpleReply, false);
  assert.equal(result.projectIntent, true);
});

test('booking and quote paths override simple', () => {
  assert.equal(detectMessageIntent('Hello can I book a call?', 'general business', {}).bookingIntent, true);
  assert.equal(detectMessageIntent('Hello can I book a call?', 'general business', {}).shouldUseSimpleReply, false);
  assert.equal(detectMessageIntent('Thanks, can I get a quote?', 'general business', {}).shouldUseSimpleReply, false);
});

test('budget and lead/project signals', () => {
  const result = detectMessageIntent('Okay my budget is £2000', 'general business', {});
  assert.equal(result.projectIntent, true);
  assert.equal(result.leadIntent, false);
});

test('industry-specific intent detection across categories', () => {
  assert.equal(detectMessageIntent('Hi I need a roof repair quote', 'construction', {}).projectIntent, true);
  assert.equal(detectMessageIntent('Hello I want to book a dentist appointment', 'healthcare', {}).bookingIntent, true);
  assert.equal(detectMessageIntent('Hi I want to schedule a demo', 'saas', {}).bookingIntent, true);
  assert.equal(detectMessageIntent('Hi where is my order?', 'ecommerce', {}).supportIntent, true);
});

test('failed church example is project intent with reasons', () => {
  const msg = 'Hi we are small church maybe 80 people we have old website but no one update it and we want events sermon youtube maybe donation also not sure budget but need someone manage everything because volunteers busy can you help and what next';
  const result = detectMessageIntent(msg, 'web_agency', {});
  assert.equal(result.shouldUseSimpleReply, false);
  assert.equal(result.projectIntent, true);
  for (const expected of ['website', 'events', 'sermon', 'donation', 'budget', 'manage', 'volunteers', 'can you help', 'what next']) {
    assert.equal(result.reasons.includes(expected), true);
  }
});
