export function safeLeadExtractorErrorCode(error) {
  const message = String(error?.message || '').toLowerCase();
  if (error?.name === 'AbortError' || message.includes('lead_extractor_timeout') || message.includes('timed out') || message.includes('timeout')) return 'timeout';
  if (error?.status === 429 || error?.code === 'rate_limit_exceeded' || message.includes('rate limit') || message.includes('quota')) return 'rate_limit_or_quota';
  if (message.includes('json')) return 'invalid_json';
  if (message.includes('api key') || message.includes('auth')) return 'auth_or_key';
  return 'api_failure';
}

export async function withTimeout(promiseFactory, timeoutMs) {
  const controller = new AbortController();
  let timeoutHandle;
  try {
    const timeoutPromise = new Promise((_, reject) => {
      timeoutHandle = setTimeout(() => {
        controller.abort();
        reject(new Error('lead_extractor_timeout'));
      }, timeoutMs);
    });
    return await Promise.race([promiseFactory(controller.signal), timeoutPromise]);
  } finally {
    clearTimeout(timeoutHandle);
  }
}
