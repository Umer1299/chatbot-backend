export function detectBookingSignals(message = '') {
  const text = String(message || '').toLowerCase();
  const bookingIntentDetected = /\b(book a call|schedule a call|discovery call|arrange a call|can we talk|speak to someone|call me|send calendly|calendly link|book(ing)? call|schedule)\b/.test(text)
    || /\b(available\s+(on\s+)?(monday|tuesday|wednesday|thursday|friday|saturday|sunday))\b/.test(text)
    || /\bnext\s+(monday|tuesday|wednesday|thursday|friday|saturday|sunday)(\s+(morning|afternoon|evening))?\b/.test(text)
    || /\b(tomorrow|this\s+(morning|afternoon|evening))\b/.test(text);

  const calendlyRequested = /\b(send calendly|calendly link|send me (the )?calendly|book a call|schedule a call|discovery call|arrange a call)\b/.test(text);
  const preferredTimeDetected = /\b(available\s+(on\s+)?(monday|tuesday|wednesday|thursday|friday|saturday|sunday)|next\s+(monday|tuesday|wednesday|thursday|friday|saturday|sunday)|tomorrow|morning|afternoon|evening|\d{1,2}\s?(am|pm))\b/.test(text);
  const callbackRequested = /\b(call me|can we talk|speak to someone|someone call me|phone me)\b/.test(text) || (/\bdon['’]?t want booking link\b/.test(text) && /\bcall\b/.test(text));

  return { bookingIntentDetected, calendlyRequested, preferredTimeDetected, callbackRequested };
}

export function buildBookingReply(message, config = {}) {
  const signals = detectBookingSignals(message);
  if (!signals.bookingIntentDetected) return null;

  const calendlyLink = config.calendly_link || config.calendlyLink || null;
  const businessName = config.business_name ? ` at ${config.business_name}` : '';
  const base = `Absolutely — we'd be happy to arrange a discovery call${businessName}.`;

  if (signals.callbackRequested) {
    return {
      source: 'booking_flow',
      reply: `${base} Please share your best phone number and preferred time, and our team will call you back.`,
      calendlyLinkShown: false,
      ...signals
    };
  }

  if (calendlyLink && signals.calendlyRequested) {
    return {
      source: 'saved_booking_reply',
      reply: `${base} You can book here: ${calendlyLink}`,
      calendlyLinkShown: true,
      ...signals
    };
  }

  if (calendlyLink) {
    return {
      source: 'booking_flow',
      reply: `${base} You can pick a time here: ${calendlyLink}${signals.preferredTimeDetected ? ' If you prefer, share your ideal time and we can help coordinate.' : ''}`,
      calendlyLinkShown: true,
      ...signals
    };
  }

  return {
    source: 'booking_flow',
    reply: `${base} Share your preferred day/time and we'll help schedule it for you.`,
    calendlyLinkShown: false,
    ...signals
  };
}
