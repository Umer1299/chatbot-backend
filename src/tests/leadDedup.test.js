import assert from 'assert';
import { normalizeEmail, shouldUseSessionDedupe, pickMostCompleteLead } from '../services/leadDedup.js';

assert.equal(normalizeEmail('Olivia@LighthouseCambridge.org.uk'), 'olivia@lighthousecambridge.org.uk');
assert.equal(normalizeEmail('  A@B.COM '), 'a@b.com');

// Same email with different session_id should dedupe by email (session dedupe disabled)
assert.equal(shouldUseSessionDedupe({ email: 'a@x.com', phone: null }), false);

// Same session with different email should create new lead candidate (no session dedupe once email exists)
assert.equal(shouldUseSessionDedupe({ email: 'b@x.com', phone: null }), false);

// session_id dedupe only when both missing
assert.equal(shouldUseSessionDedupe({ email: null, phone: '' }), true);

const leads = [
  { id: '1', full_name: 'Olivia Bennett', email: 'olivia@lighthousecambridge.org.uk', updated_at: '2026-01-01T00:00:00Z' },
  { id: '2', full_name: 'Olivia Bennett', email: 'olivia@lighthousecambridge.org.uk', phone: '12345', company_name: 'Lighthouse', updated_at: '2026-01-02T00:00:00Z' }
];
assert.equal(pickMostCompleteLead(leads).id, '2');

console.log('leadDedup tests passed');
