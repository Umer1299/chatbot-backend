import { fromNodeHeaders, toNodeHandler } from "better-auth/node";
import { getAccountAuth } from "../auth/runtime.js";
import { parseHttpOrigin } from "./corsPolicy.js";

const authPaths = new Set([
  "POST /sign-up/email",
  "POST /sign-in/email",
  "POST /sign-out",
  "GET /get-session",
  "POST /request-password-reset",
  "POST /reset-password",
  "POST /send-verification-email",
  "GET /verify-email",
  "GET /list-sessions",
  "POST /revoke-session",
  "POST /revoke-sessions",
  "POST /revoke-other-sessions",
]);
const organizationPaths = new Set([
  "POST /organization/create",
  "GET /organization/list",
  "GET /organization/get-full-organization",
  "POST /organization/update",
  "POST /organization/invite-member",
  "POST /organization/accept-invitation",
  "POST /organization/reject-invitation",
  "POST /organization/cancel-invitation",
  "GET /organization/get-invitation",
  "GET /organization/list-invitations",
  "GET /organization/list-user-invitations",
  "GET /organization/list-members",
  "POST /organization/remove-member",
  "POST /organization/update-member-role",
  "POST /organization/leave",
]);
const sessionPaths = new Set([
  "GET /get-session",
  "GET /list-sessions",
  "POST /revoke-session",
  "POST /revoke-sessions",
  "POST /revoke-other-sessions",
]);

export function checkAccountOrigin(req, auth) {
  if (["GET", "HEAD", "OPTIONS"].includes(req.method)) return;
  const origin = parseHttpOrigin(req.headers.origin);
  if (!origin || !auth.options.trustedOrigins.includes(origin.origin)) {
    throw Object.assign(new Error("Trusted account origin required"), {
      status: 403,
    });
  }
  if (
    !/^application\/json(?:\s*;|$)/i.test(req.headers["content-type"] || "")
  ) {
    throw Object.assign(new Error("JSON content type required"), {
      status: 415,
    });
  }
}

export async function readAccountIdentity(auth, headers) {
  const identity = await auth.api.getSession({
    headers: fromNodeHeaders(headers),
    query: { disableCookieCache: true, disableRefresh: true },
  });
  if (
    !identity ||
    identity.user.status !== "active" ||
    identity.user.emailVerified !== true
  ) {
    throw Object.assign(new Error("Verified active session required"), {
      status: 401,
    });
  }
  return identity;
}

export function accountIdentity(getAuth = getAccountAuth) {
  return async (req, res, next) => {
    try {
      const auth = getAuth();
      req.headers["x-chatflow-client-ip"] = req.ip;
      checkAccountOrigin(req, auth);
      const identity = await readAccountIdentity(auth, req.headers);
      // New namespace only: never use req.business/req.auth from legacy JWTs.
      req.accountUser = identity.user;
      req.accountSession = identity.session;
      next();
    } catch (error) {
      next(error);
    }
  };
}

export function accountHandler(getAuth = getAccountAuth) {
  return async (req, res, next) => {
    try {
      const endpoint = `${req.method} ${req.path.slice("/api/account".length)}`;
      if (
        !authPaths.has(endpoint) &&
        !organizationPaths.has(endpoint) &&
        !/^GET \/reset-password\/[A-Za-z0-9_-]{1,512}$/.test(endpoint)
      )
        return res.status(404).json({ error: "Account endpoint not found" });
      const auth = getAuth();
      req.headers["x-chatflow-client-ip"] = req.ip;
      checkAccountOrigin(req, auth);
      if (organizationPaths.has(endpoint) || sessionPaths.has(endpoint))
        await readAccountIdentity(auth, req.headers);
      return await toNodeHandler(auth)(req, res);
    } catch (error) {
      next(error);
    }
  };
}
