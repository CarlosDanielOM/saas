import type { NextFunction, Request, Response } from 'express';
import { createHmac, timingSafeEqual } from 'crypto';

export interface TwitchExtensionIdentity {
  channelID: string;
  userID?: string;
  opaqueUserID?: string;
  role?: string;
  token: string;
  identityShared: boolean;
}

export interface TwitchExtensionRequest extends Request {
  extension?: TwitchExtensionIdentity;
}

interface TwitchExtensionJwtPayload {
  channel_id?: string;
  user_id?: string;
  opaque_user_id?: string;
  role?: string;
  exp?: number;
}

function getSigningSecrets(): Buffer[] {
  const secret = process.env.TWITCH_EXTENSION_SECRET;
  if (!secret) return [];

  const candidates = [
    Buffer.from(secret, 'base64'),
    Buffer.from(secret, 'base64url'),
    Buffer.from(secret, 'utf8')
  ];

  return candidates.filter((candidate, index) =>
    candidate.length > 0 && candidates.findIndex((other) => other.equals(candidate)) === index
  );
}

function getToken(req: Request): string | null {
  const authHeader = req.header('authorization');
  if (authHeader?.startsWith('Bearer ')) {
    return authHeader.slice(7);
  }

  const extensionHeader = req.header('x-extension-jwt');
  return extensionHeader || null;
}

function decodeUnverified(token: string): TwitchExtensionJwtPayload | null {
  const parts = token.split('.');
  if (parts.length < 2 || !parts[1]) return null;

  try {
    return JSON.parse(base64UrlDecode(parts[1]).toString('utf8')) as TwitchExtensionJwtPayload;
  } catch {
    return null;
  }
}

function base64UrlDecode(value: string): Buffer {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=');
  return Buffer.from(padded, 'base64');
}

function verifyTwitchJwt(token: string, signingSecrets: Buffer[]): TwitchExtensionJwtPayload | null {
  const parts = token.split('.');
  if (parts.length !== 3 || !parts[0] || !parts[1] || !parts[2]) return null;

  const header = JSON.parse(base64UrlDecode(parts[0]).toString('utf8')) as { alg?: string };
  if (header.alg !== 'HS256') return null;

  const signedPayload = `${parts[0]}.${parts[1]}`;
  const actualSignature = base64UrlDecode(parts[2]);

  for (const signingSecret of signingSecrets) {
    const expectedSignature = createHmac('sha256', signingSecret).update(signedPayload).digest();
    if (expectedSignature.length === actualSignature.length && timingSafeEqual(expectedSignature, actualSignature)) {
      const payload = decodeUnverified(token);
      if (!payload) return null;
      if (payload.exp && payload.exp * 1000 < Date.now()) return null;

      return payload;
    }
  }

  return null;
}

function getTokenDiagnostics(token: string): Record<string, unknown> {
  const parts = token.split('.');
  const payload = decodeUnverified(token);
  let alg: string | undefined;

  try {
    alg = parts[0] ? (JSON.parse(base64UrlDecode(parts[0]).toString('utf8')) as { alg?: string }).alg : undefined;
  } catch {
    alg = undefined;
  }

  return {
    tokenParts: parts.length,
    alg,
    hasChannelID: Boolean(payload?.channel_id),
    hasUserID: Boolean(payload?.user_id),
    hasOpaqueUserID: Boolean(payload?.opaque_user_id),
    isExpired: Boolean(payload?.exp && payload.exp * 1000 < Date.now())
  };
}

export function twitchExtensionAuth(req: TwitchExtensionRequest, res: Response, next: NextFunction): void {
  const token = getToken(req);
  if (!token) {
    res.status(401).json({ error: true, message: 'Missing Twitch Extension token', status: 401 });
    return;
  }

  const allowUnverified = process.env.DIMAFX_ALLOW_UNVERIFIED_TWITCH_JWT === 'true';
  const signingSecrets = getSigningSecrets();

  try {
    const payload = signingSecrets.length > 0
      ? verifyTwitchJwt(token, signingSecrets)
      : allowUnverified
        ? decodeUnverified(token)
        : null;

    if (!payload?.channel_id) {
      console.warn('Invalid Twitch Extension token:', {
        hasSigningSecret: signingSecrets.length > 0,
        allowUnverified,
        ...getTokenDiagnostics(token),
        timestamp: new Date().toISOString()
      });
      res.status(401).json({ error: true, message: 'Invalid Twitch Extension token', status: 401 });
      return;
    }

    req.extension = {
      channelID: payload.channel_id,
      userID: payload.user_id,
      opaqueUserID: payload.opaque_user_id,
      role: payload.role,
      token,
      identityShared: Boolean(payload.user_id)
    };

    next();
  } catch (error) {
    console.error('Twitch Extension JWT validation failed:', {
      error: error instanceof Error ? error.message : String(error),
      timestamp: new Date().toISOString()
    });
    res.status(401).json({ error: true, message: 'Invalid Twitch Extension token', status: 401 });
  }
}

export function ensureChannelMatches(req: TwitchExtensionRequest, res: Response, channelID: string): boolean {
  if (!req.extension?.channelID || req.extension.channelID !== channelID) {
    res.status(403).json({ error: true, message: 'Extension channel mismatch', status: 403 });
    return false;
  }

  return true;
}
