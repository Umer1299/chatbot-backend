import { betterAuth } from "better-auth";
import { organization } from "better-auth/plugins";
import { APIError } from "better-auth/api";
import { parseHttpOrigin } from "../middleware/corsPolicy.js";
import { trustedProxySettings } from "../middleware/trustedProxy.js";

export function accountSettings(env = process.env) {
  const proxy = trustedProxySettings(env);
  if (env.NODE_ENV === "production" && !proxy.mode)
    throw new Error(
      "Production account authentication requires explicit proxy mode",
    );
  const base = parseHttpOrigin(env.ACCOUNT_AUTH_URL);
  const origins = (env.ACCOUNT_TRUSTED_ORIGINS || "")
    .split(",")
    .filter(Boolean)
    .map((value) => {
      const origin = parseHttpOrigin(value.trim());
      if (!origin || origin.hostname.includes("*"))
        throw new Error("Invalid account origin configuration");
      return origin.origin;
    });
  if (
    !base ||
    !origins.length ||
    !origins.includes(base.origin) ||
    (env.ACCOUNT_AUTH_SECRET || "").length < 32
  ) {
    throw new Error(
      "Account authentication requires URL, secret and exact trusted origins",
    );
  }
  if (
    env.NODE_ENV === "production" &&
    (base.protocol !== "https:" ||
      origins.some((o) => !o.startsWith("https://")))
  ) {
    throw new Error("Production account authentication requires HTTPS");
  }
  return {
    baseURL: base.origin,
    secret: env.ACCOUNT_AUTH_SECRET,
    trustedOrigins: origins,
    production: env.NODE_ENV === "production",
  };
}

// Factory supports isolated test databases. Never initializes or migrates schema.
export function createAccountAuth({ database, settings, sendEmail }) {
  const activeUser = async (id) => {
    const { rows } = await database.query(
      'SELECT status, "emailVerified" FROM chatflow_user WHERE id=$1',
      [id],
    );
    if (rows[0]?.status !== "active" || rows[0]?.emailVerified !== true)
      throw new APIError("FORBIDDEN", {
        message: "Verified active account required",
      });
  };
  return betterAuth({
    appName: "Chatflow AI",
    basePath: "/api/account",
    baseURL: settings.baseURL,
    secret: settings.secret,
    trustedOrigins: settings.trustedOrigins,
    database, // pg.Pool; library owns password/session/reset implementation.
    user: {
      modelName: "chatflow_user",
      additionalFields: {
        status: {
          type: "string",
          required: true,
          defaultValue: "active",
          input: false,
        },
      },
    },
    account: {
      modelName: "chatflow_account",
      accountLinking: { enabled: false },
    },
    verification: { modelName: "chatflow_verification" },
    session: {
      modelName: "chatflow_session",
      expiresIn: 60 * 60 * 24 * 7,
      updateAge: 60 * 60 * 24,
      cookieCache: { enabled: false },
    },
    emailAndPassword: {
      enabled: true,
      requireEmailVerification: true,
      autoSignIn: false,
      minPasswordLength: 12,
      maxPasswordLength: 128,
      revokeSessionsOnPasswordReset: true,
      sendResetPassword: async ({ user, url }) =>
        sendEmail({
          to: user.email,
          subject: "Reset your Chatflow AI password",
          url,
        }),
    },
    emailVerification: {
      sendOnSignUp: true,
      sendOnSignIn: true,
      autoSignInAfterVerification: false,
      expiresIn: 3600,
      sendVerificationEmail: async ({ user, url }) =>
        sendEmail({
          to: user.email,
          subject: "Verify your Chatflow AI email",
          url,
        }),
    },
    databaseHooks: {
      session: {
        create: {
          before: async (session) => {
            await activeUser(session.userId);
          },
        },
      },
    },
    rateLimit: {
      enabled: true,
      storage: "database",
      modelName: "chatflow_rate_limit",
      window: 60,
      max: 100,
    },
    advanced: {
      cookiePrefix: "chatflow",
      useSecureCookies: settings.production,
      defaultCookieAttributes: {
        httpOnly: true,
        secure: settings.production,
        sameSite: "lax",
        path: "/",
      },
      ipAddress: { ipAddressHeaders: ["x-chatflow-client-ip"] }, // Only the Express handler writes this header from req.ip; forwarded headers cannot choose quota identity.
      disableCSRFCheck: false,
      disableOriginCheck: false,
    },
    plugins: [
      organization({
        allowUserToCreateOrganization: (user) =>
          user.emailVerified === true && user.status === "active",
        requireEmailVerificationOnInvitation: true,
        disableOrganizationDeletion: true,
        schema: {
          organization: { modelName: "chatflow_organization" },
          member: { modelName: "chatflow_member" },
          invitation: { modelName: "chatflow_invitation" },
        },
        sendInvitationEmail: async (data) => {
          const url = new URL("/accept-invitation", settings.trustedOrigins[0]);
          url.searchParams.set("invitationId", data.id);
          await sendEmail({
            to: data.email,
            subject: "Chatflow AI agency invitation",
            url: url.href,
          });
        },
      }),
    ],
    telemetry: { enabled: false },
    logger: { level: "error" },
  });
}
