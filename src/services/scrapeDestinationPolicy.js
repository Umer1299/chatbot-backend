import dns from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import { isIP } from 'node:net';
import ipaddr from 'ipaddr.js';

const MAX_URL_LENGTH = 2048;
const MAX_REDIRECTS = 5;
const MAX_HTML_BYTES = 2 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 30000;
const DNS_TIMEOUT_MS = 5000;

const ipv4ExtraBlocked = [
  '192.0.0.0/24', '192.88.99.0/24', '198.18.0.0/15',
].map(value => ipaddr.parseCIDR(value));
const ipv6Public = ipaddr.parseCIDR('2000::/3');
const ipv6ExtraBlocked = ['2001::/23', '2002::/16', '3fff::/20'].map(value => ipaddr.parseCIDR(value));

const unsafe = () => Object.assign(new Error('Unsafe scrape destination'), { status: 400, code: 'UNSAFE_SCRAPE_DESTINATION' });

function hostWithoutBrackets(hostname) {
  return hostname.startsWith('[') ? hostname.slice(1, -1) : hostname;
}

export function isPublicAddress(value) {
  try {
    const parsed = ipaddr.process(value);
    if (parsed.range() !== 'unicast') return false;
    if (parsed.kind() === 'ipv4') return !ipv4ExtraBlocked.some(cidr => parsed.match(cidr));
    return parsed.match(ipv6Public) && !ipv6ExtraBlocked.some(cidr => parsed.match(cidr));
  } catch {
    return false;
  }
}

export function parsePublicWebsiteUrl(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > MAX_URL_LENGTH ||
      /[\u0000-\u001f\u007f\\]/.test(value)) throw unsafe();
  const raw = value.trim();
  if (raw.startsWith('/') || raw.startsWith('?') || raw.startsWith('#')) throw unsafe();
  const input = /^[a-z][a-z\d+.-]*:/i.test(raw) ? raw : `https://${raw}`;
  let url;
  try { url = new URL(input); } catch { throw unsafe(); }
  if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password ||
      url.port || url.href.length > MAX_URL_LENGTH) throw unsafe();
  const host = hostWithoutBrackets(url.hostname).replace(/\.$/, '').toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost') ||
      (isIP(host) && !isPublicAddress(host))) throw unsafe();
  url.hash = '';
  return url;
}

export async function resolvePublicWebsite(url, resolver = dns.lookup) {
  const host = hostWithoutBrackets(url.hostname);
  if (isIP(host)) {
    if (!isPublicAddress(host)) throw unsafe();
    return { address: host, family: isIP(host) };
  }
  let timer;
  let answers;
  try {
    answers = await Promise.race([
      resolver(host, { all: true, verbatim: true }),
      new Promise((_, reject) => { timer = setTimeout(() => reject(unsafe()), DNS_TIMEOUT_MS); }),
    ]);
  } catch { throw unsafe(); } finally { clearTimeout(timer); }
  if (!Array.isArray(answers) || answers.length === 0 ||
      answers.some(answer => !answer || ![4, 6].includes(answer.family) ||
        isIP(answer.address) !== answer.family || !isPublicAddress(answer.address))) throw unsafe();
  return answers[0];
}

// The request uses the vetted address, not a second DNS lookup. The URL still
// supplies Host and (for HTTPS) SNI/certificate hostname verification.
export function createPublicWebsiteClient({
  resolver = dns.lookup,
  httpRequest = http.request,
  httpsRequest = https.request,
  requestTimeoutMs = REQUEST_TIMEOUT_MS,
  maxHtmlBytes = MAX_HTML_BYTES,
} = {}) {
  async function oneHop(url, destination) {
    return new Promise((resolve, reject) => {
      const host = hostWithoutBrackets(url.hostname);
      const request = url.protocol === 'https:' ? httpsRequest : httpRequest;
      const options = {
        agent: false,
        method: 'GET',
        headers: {
          Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'User-Agent': 'Mozilla/5.0 (compatible; ChatflowAIBot/1.0; +https://chatflowai.io)',
        },
        lookup: (requestedHost, _options, callback) => {
          if (requestedHost !== host) return callback(unsafe());
          callback(null, destination.address, destination.family);
        },
        ...(url.protocol === 'https:' && !isIP(host) ? { servername: host, rejectUnauthorized: true } : {}),
      };
      const req = request(url, options, response => {
        const chunks = [];
        let bytes = 0;
        response.on('data', chunk => {
          bytes += chunk.length;
          if (bytes > maxHtmlBytes) {
            req.destroy(Object.assign(new Error('Scrape response too large'), { code: 'SCRAPE_RESPONSE_TOO_LARGE' }));
            return;
          }
          chunks.push(chunk);
        });
        response.on('error', error => { clearTimeout(timer); reject(error); });
        response.on('end', () => { clearTimeout(timer); resolve({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks) }); });
      });
      req.on('error', error => { clearTimeout(timer); reject(error); });
      const timer = setTimeout(() => req.destroy(new Error('Scrape request timed out')), requestTimeoutMs);
      req.end();
    });
  }

  return async function fetchPublicWebsite(input) {
    let url = parsePublicWebsiteUrl(input);
    const seen = new Set();
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      if (seen.has(url.href)) throw unsafe();
      seen.add(url.href);
      const destination = await resolvePublicWebsite(url, resolver);
      const result = await oneHop(url, destination);
      if ([301, 302, 303, 307, 308].includes(result.status)) {
        if (hop === MAX_REDIRECTS || typeof result.headers.location !== 'string') throw unsafe();
        let target;
        try { target = new URL(result.headers.location, url); } catch { throw unsafe(); }
        url = parsePublicWebsiteUrl(target.href);
        continue;
      }
      const headers = new Headers(result.headers);
      return {
        ok: result.status >= 200 && result.status < 300,
        status: result.status,
        statusText: http.STATUS_CODES[result.status] || '',
        headers,
        url: url.href,
        text: async () => result.body.toString('utf8'),
      };
    }
    throw unsafe();
  };
}

export const fetchPublicWebsite = createPublicWebsiteClient();
