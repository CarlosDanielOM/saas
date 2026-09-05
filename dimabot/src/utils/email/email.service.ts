/**
 * Email Service
 *
 * Uses Resend + React Email for sending transactional emails.
 */

import { Resend } from "resend";
import { render } from "@react-email/render";
import type { ReactElement } from "react";
import jwt from "jsonwebtoken";

// Email config from environment
const RESEND_API_KEY = process.env.RESEND_API_KEY;
const EMAIL_FROM =
  process.env.EMAIL_FROM || "DomDimaBot <noreply@notifications.domdimabot.com>";
const ACTIVATION_URL =
  process.env.ACTIVATION_URL || "https://domdimabot.com/login";
const DASHBOARD_URL = process.env.DASHBOARD_URL || "https://domdimabot.com";
const DEFAULT_DISCOUNT_CODE = process.env.DEFAULT_DISCOUNT_CODE || "";
const EMAIL_AUTH_BASE_URL =
  process.env.EMAIL_AUTH_BASE_URL || "https://api.domdimabot.com/email/auth";
const EMAIL_AUTH_JWT_SECRET = process.env.EMAIL_AUTH_JWT_SECRET || "";

// Initialize Resend client
const resend = RESEND_API_KEY ? new Resend(RESEND_API_KEY) : null;

interface SendEmailOptions {
  to: string;
  subject: string;
  emailComponent: ReactElement;
  from?: string;
  idempotencyKey?: string;
}

export interface RenderedEmailPayload {
  from: string;
  to: string[];
  subject: string;
  html: string;
  text: string;
}

export async function renderEmail({
  to,
  subject,
  emailComponent,
  from,
}: Omit<SendEmailOptions, "idempotencyKey">): Promise<RenderedEmailPayload> {
  const [html, text] = await Promise.all([
    render(emailComponent, { pretty: true }),
    render(emailComponent, { plainText: true }),
  ]);
  return { from: from || EMAIL_FROM, to: [to], subject, html, text };
}

export async function sendRenderedEmail(
  { from, to, subject, html, text }: RenderedEmailPayload,
  idempotencyKey?: string,
): Promise<{ error: boolean; message: string; data?: any }> {
  if (!resend) {
    console.error("[EmailService] Resend not configured - missing RESEND_API_KEY");
    return { error: true, message: "Email service not configured" };
  }
  if (!to.length || to.some((recipient) => !recipient)) {
    console.error("[EmailService] No recipient email provided");
    return { error: true, message: "No recipient email provided" };
  }

  const result = await resend.emails.send(
    { from, to, subject, html, text },
    idempotencyKey ? { idempotencyKey } : undefined,
  );
  if (result.error) {
    console.error("[EmailService] Failed to send email:", result.error);
    return {
      error: true,
      message: result.error.message || "Failed to send email",
    };
  }

  console.log(`[EmailService] Email sent successfully to ${to.join(", ")}: ${subject}`);
  return { error: false, message: "Email sent successfully", data: result.data };
}

/**
 * Send an email using Resend
 */
export async function sendEmail({
  to,
  subject,
  emailComponent,
  from,
  idempotencyKey,
}: SendEmailOptions): Promise<{ error: boolean; message: string; data?: any }> {
  if (!resend) {
    console.error(
      "[EmailService] Resend not configured - missing RESEND_API_KEY",
    );
    return { error: true, message: "Email service not configured" };
  }

  if (!to) {
    console.error("[EmailService] No recipient email provided");
    return { error: true, message: "No recipient email provided" };
  }

  try {
    const payload = await renderEmail({ to, subject, emailComponent, from });
    return await sendRenderedEmail(payload, idempotencyKey);
  } catch (error) {
    console.error("[EmailService] Error sending email:", {
      to,
      subject,
      error: error instanceof Error ? error.message : String(error),
    });
    return {
      error: true,
      message:
        error instanceof Error ? error.message : "Unknown error sending email",
    };
  }
}

// Re-export email config for use in templates
export { ACTIVATION_URL, DASHBOARD_URL, DEFAULT_DISCOUNT_CODE, EMAIL_AUTH_BASE_URL };

// Re-export the email activation token signer (used by reminder worker and tests)
export { signEmailActivationToken, verifyEmailActivationToken } from "./email-activation-token.js";
