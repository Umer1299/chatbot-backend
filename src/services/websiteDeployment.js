import { randomBytes, createHash } from "node:crypto";
import { parseHttpOrigin } from "../middleware/corsPolicy.js";
const invalid = () =>
  Object.assign(new Error("Invalid deployment policy"), { status: 400 });
export function validateOrigins(values) {
  if (!Array.isArray(values) || !values.length || values.length > 20)
    throw invalid();
  const normalized = values.map((value) => {
    const url = parseHttpOrigin(value);
    if (
      !url ||
      url.hostname.includes("*") ||
      url.origin !== value ||
      (url.protocol !== "https:" &&
        !(
          url.protocol === "http:" &&
          ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
        ))
    )
      throw invalid();
    return url.origin;
  });
  if (new Set(normalized).size !== normalized.length) throw invalid();
  return normalized;
}
export function issueCredential() {
  const token = `wct_${randomBytes(32).toString("base64url")}`;
  return { token, verifier: hashCredential(token) };
}
export function hashCredential(token) {
  // Exact canonical shape; do not accept public deployment IDs as credentials.
  if (typeof token !== "string" || !/^wct_[A-Za-z0-9_-]{43}$/.test(token))
    return null;
  return createHash("sha256").update(token).digest();
}
