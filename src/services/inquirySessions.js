// Preserve the existing short-lived classification without intercepting global SQL.
const inquiryOnlySessions = new Set();
export const isInquiryOnlySession = (businessId, sessionId) =>
  inquiryOnlySessions.has(`${businessId}:${sessionId}`);
export function rememberInquiryOnlySession(businessId, sessionId) {
  if (!businessId || !sessionId) return;
  const key = `${businessId}:${sessionId}`;
  inquiryOnlySessions.add(key);
  setTimeout(() => inquiryOnlySessions.delete(key), 30 * 60 * 1000).unref?.();
}
