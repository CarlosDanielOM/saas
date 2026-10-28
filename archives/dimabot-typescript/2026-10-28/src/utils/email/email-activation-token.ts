import jwt from "jsonwebtoken";

const EMAIL_AUTH_JWT_SECRET = process.env.EMAIL_AUTH_JWT_SECRET || "";

function getSecret(): string {
  if (!EMAIL_AUTH_JWT_SECRET) {
    console.warn("[email-activation-token] EMAIL_AUTH_JWT_SECRET is not set. Falling back to insecure dev secret.");
    return "dev-insecure-do-not-use-in-prod";
  }
  return EMAIL_AUTH_JWT_SECRET;
}

export interface EmailActivationTokenPayload {
  sub: string;   // Mongo user _id
  login: string; // Twitch login (used as state)
}

/**
 * Signs a short-lived (1 hour) JWT used in activation reminder emails.
 */
export function signEmailActivationToken(userId: string, twitchLogin: string): string {
  const secret = getSecret();
  return jwt.sign(
    { sub: userId, login: twitchLogin } as EmailActivationTokenPayload,
    secret,
    { expiresIn: "1h" }
  );
}

/**
 * Verifies and decodes an activation email token.
 * Returns null on any failure (expired, bad signature, malformed, etc).
 */
export function verifyEmailActivationToken(token: string): { userId: string; login: string } | null {
  if (!token) return null;
  const secret = getSecret();
  try {
    const payload = jwt.verify(token, secret) as any;
    if (payload && typeof payload.sub === "string" && typeof payload.login === "string") {
      return { userId: payload.sub, login: payload.login };
    }
    return null;
  } catch {
    return null;
  }
}
