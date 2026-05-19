import test from 'node:test';
import assert from 'node:assert/strict';
import { buildBookingReply } from '../src/services/bookingFlow.js';

const cfg = { business_name: 'UKChurches', calendly_link: 'https://calendly.com/ukchurches/discovery' };

test('Can I book a discovery call should not return thanks flow', () => {
  const result = buildBookingReply('Can I book a discovery call?', cfg);
  assert.ok(result);
  assert.notEqual(result.source, 'saved_simple_reply');
  assert.equal(result.bookingIntentDetected, true);
});

test('Send me the Calendly link please should return booking link', () => {
  const result = buildBookingReply('Send me the Calendly link please', cfg);
  assert.match(result.reply, /calendly\.com/);
  assert.equal(result.calendlyLinkShown, true);
});

test('callback requested sentence should set callbackRequested', () => {
  const result = buildBookingReply("I don't want booking link, can someone call me tomorrow?", cfg);
  assert.equal(result.callbackRequested, true);
  assert.equal(result.calendlyLinkShown, false);
});

test('Thanks should not trigger booking flow', () => {
  const result = buildBookingReply('Thanks', cfg);
  assert.equal(result, null);
});

test('Thanks, can I book a call should trigger booking flow', () => {
  const result = buildBookingReply('Thanks, can I book a call?', cfg);
  assert.ok(result);
  assert.notEqual(result.source, 'saved_simple_reply');
  assert.equal(result.bookingIntentDetected, true);
});
