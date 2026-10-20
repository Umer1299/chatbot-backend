import { Resend } from "resend";

// Identity email must fail closed instead of silently skipping a missing provider.
export async function sendAccountEmail({ to, subject, url }) {
  if (!process.env.RESEND_API_KEY)
    throw new Error("Account email delivery unavailable");
  const result = await new Resend(process.env.RESEND_API_KEY).emails.send({
    from: `${process.env.RESEND_FROM_NAME || "Chatflow AI"} <${process.env.RESEND_FROM_EMAIL || "support@chatflowai.io"}>`,
    to,
    subject,
    text: `${subject}\n\n${url}\n\nIf you did not request this, you can ignore this email.`,
  });
  if (result.error) throw new Error("Account email delivery failed");
}
