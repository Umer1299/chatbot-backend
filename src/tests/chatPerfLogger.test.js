import assert from 'assert';
import { sanitizeError } from '../utils/chatPerfLogger.js';

const err = sanitizeError(new Error('authorization=Bearer abcdefghijklmnopqrstuvwxyz123456 and token: supersecret'));
assert(!err.includes('supersecret'));
assert(!/abcdefghijklmnopqrstuvwxyz123456/.test(err));
console.log('chatPerfLogger test passed');
