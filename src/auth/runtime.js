import pool from "../db/pool.js";
import { accountSettings, createAccountAuth } from "./accountAuth.js";
import { sendAccountEmail } from "../services/accountEmail.js";
let instance;
export function getAccountAuth() {
  if (process.env.ACCOUNT_AUTH_ENABLED !== "true")
    throw Object.assign(new Error("Account authentication unavailable"), {
      status: 503,
    });
  if (!instance) {
    try {
      if (!process.env.RESEND_API_KEY)
        throw new Error("Email configuration required");
      instance = createAccountAuth({
        database: pool,
        settings: accountSettings(),
        sendEmail: sendAccountEmail,
      });
    } catch {
      throw Object.assign(new Error("Account authentication unavailable"), {
        status: 503,
      });
    }
  }
  return instance;
}
