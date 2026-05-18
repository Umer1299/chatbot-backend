import { randomUUID } from 'crypto';

function envFlag(value) {
  if (typeof value === 'string') return value.toLowerCase() === 'true';
  return null;
}

export function shouldLogChatPerf() {
  const explicit = envFlag(process.env.CHAT_PERF_LOGS);
  if (explicit !== null) return explicit;
  return process.env.NODE_ENV !== 'production';
}

export function sanitizeError(error) {
  const raw = String(error?.message || error || 'unknown_error');
  return raw
    .replace(/[A-Za-z0-9_\-]{24,}/g, '[redacted]')
    .replace(/(api[_-]?key|authorization|token|cookie)\s*[:=]\s*[^\s]+/ig, '$1=[redacted]')
    .slice(0, 240);
}

export function getRequestId(req) {
  const existing = req?.id || req?.requestId || req?.headers?.['x-request-id'];
  return existing || randomUUID();
}

export function createChatLogger(base = {}, detailed = shouldLogChatPerf()) {
  const baseMeta = { ...base };
  const timers = new Map();

  const emit = (level, payload = {}, force = false) => {
    if (!force && !detailed) return;
    const entry = {
      timestamp: new Date().toISOString(),
      ...baseMeta,
      ...payload
    };
    if (level === 'warn') console.warn(JSON.stringify(entry));
    else if (level === 'error') console.error(JSON.stringify(entry));
    else console.log(JSON.stringify(entry));
  };

  return {
    startTimer(label) { timers.set(label, performance.now()); },
    endTimer(label, extraFields = {}, level = 'log') {
      const start = timers.get(label);
      const durationMs = typeof start === 'number' ? Number((performance.now() - start).toFixed(2)) : null;
      timers.delete(label);
      emit(level, { event: label, durationMs, ...extraFields });
      return durationMs;
    },
    log(event, fields = {}, force = false) { emit('log', { event, ...fields }, force); },
    warn(event, fields = {}) { emit('warn', { event, ...fields }, true); },
    error(event, error, fields = {}) { emit('error', { event, error: sanitizeError(error), ...fields }, true); },
    with(fields = {}) { Object.assign(baseMeta, fields); },
    isDetailed: detailed
  };
}
