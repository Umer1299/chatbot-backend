import { isIP } from "node:net";

// No blanket trust or hop counts: deployments must name the actual ingress CIDRs.
export function trustedProxySettings(env = process.env) {
  const mode = env.ACCOUNT_PROXY_MODE;
  const entries = (env.TRUSTED_PROXY_CIDRS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (mode !== undefined && !["direct", "trusted"].includes(mode))
    throw new Error("Invalid account proxy mode");
  for (const entry of entries) {
    const parts = entry.split("/");
    const version = isIP(parts[0]);
    const prefix =
      parts[1] === undefined ? (version === 4 ? 32 : 128) : Number(parts[1]);
    if (
      parts.length > 2 ||
      !version ||
      (parts[1] !== undefined && !/^\d+$/.test(parts[1])) ||
      !Number.isInteger(prefix) ||
      prefix < 1 ||
      prefix > (version === 4 ? 32 : 128)
    ) {
      throw new Error(
        "Trusted proxies must be explicit IP addresses or bounded CIDRs",
      );
    }
  }
  if (
    (mode === "trusted" && !entries.length) ||
    (mode === "direct" && entries.length)
  )
    throw new Error("Proxy mode and CIDRs disagree");
  return { mode, trust: entries.length ? entries : false };
}

export function configureTrustedProxy(app, env = process.env) {
  app.set("trust proxy", trustedProxySettings(env).trust);
}
