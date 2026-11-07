import type { NextFunction, Request, Response } from 'express';
import { createHmac, timingSafeEqual } from 'node:crypto';

export interface TwitchExtensionIdentity {
  channelID: string;
  userID?: string;
  opaqueUserID?: string;
  role?: string;
  token: string;
  identityShared: boolean;
}
export interface TwitchExtensionRequest extends Request { extension?: TwitchExtensionIdentity }
interface TwitchExtensionJwtPayload {
  channel_id?: string; user_id?: string; opaque_user_id?: string; role?: string; exp?: number;
}
export interface VerifiedBitsTransaction {
  transactionID: string; userID: string; sku: string; amount: number; time: string; inDevelopment: boolean;
}

export function assertProductionConfiguration(): void {
  if (process.env.NODE_ENV !== 'production') return;
  const missing = ['TWITCH_EXTENSION_SECRET', 'DIMAFX_SERVICE_TOKEN'].filter(name => !process.env[name]?.trim());
  if (process.env.DIMAFX_ALLOW_UNVERIFIED_TWITCH_JWT === 'true') missing.push('DIMAFX_ALLOW_UNVERIFIED_TWITCH_JWT must be disabled');
  if (missing.length) throw new Error(`DimaFX production configuration invalid: ${missing.join(', ')}`);
}

/** Twitch extension secrets are base64 encoded, never literal UTF-8 signing keys. */
function signingSecret(): Buffer { return Buffer.from(process.env.TWITCH_EXTENSION_SECRET || '', 'base64'); }
function decode(token: string): Record<string, unknown> | null {
  try { return JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8')); } catch { return null; }
}
/** Receipts have their own replay/age policy below; authentication tokens always require exp. */
export function verifyTwitchJwt(token: string, requireExpiration = true): Record<string, unknown> | null {
  try {
    const parts = token.split('.');
    if (parts.length !== 3 || parts.some(part => !part)) return null;
    if (JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8')).alg !== 'HS256') return null;
    const key = signingSecret();
    if (!key.length) return null;
    const expected = createHmac('sha256', key).update(`${parts[0]}.${parts[1]}`).digest();
    const actual = Buffer.from(parts[2], 'base64url');
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return null;
    const payload = decode(token);
    if (!payload || (requireExpiration && !validExpiration(payload.exp))) return null;
    return payload;
  } catch { return null; }
}
function validExpiration(exp: unknown): boolean {
  return typeof exp === 'number' && Number.isFinite(exp) && exp * 1000 > Date.now();
}

export function verifyBitsReceipt(receipt: unknown, identity: TwitchExtensionIdentity): VerifiedBitsTransaction | null {
  if (typeof receipt !== 'string') return null;
  const payload = verifyTwitchJwt(receipt, false);
  if (payload?.topic !== 'bits_transaction_receipt') return null;
  const data = payload.data as { transactionId?: unknown; userId?: unknown; time?: unknown; product?: { sku?: unknown; cost?: { amount?: unknown; type?: unknown }; inDevelopment?: unknown } } | undefined;
  const product = data?.product;
  const amount = product?.cost?.amount;
  if (!data || typeof data.transactionId !== 'string' || !data.transactionId.trim() || data.transactionId.length > 256 ||
      typeof data.userId !== 'string' || !data.userId.trim() || typeof product?.sku !== 'string' || !product.sku.trim() ||
      product.cost?.type !== 'bits' || typeof amount !== 'number' || !Number.isSafeInteger(amount) || amount <= 0 ||
      (identity.userID && identity.userID !== data.userId)) return null;
  // Ignore receipt exp so a client can resume days later. A signed transaction time
  // bounds acceptance to 30 days, safely below the 365-day claim TTL; expired claims
  // can therefore never be replayed. The panel retries for seven days.
  const time = typeof data.time === 'string' ? Date.parse(data.time) : NaN;
  if (!Number.isFinite(time) || time > Date.now() + 300_000 || time < Date.now() - 30 * 86400_000) return null;
  const inDevelopment = product.inDevelopment === true;
  if (inDevelopment && process.env.DIMAFX_REJECT_DEVELOPMENT_PRODUCTS === 'true') return null;
  return { transactionID: data.transactionId, userID: data.userId, sku: product.sku, amount, time: new Date(time).toISOString(), inDevelopment };
}

export function twitchExtensionAuth(req: TwitchExtensionRequest, res: Response, next: NextFunction): void {
  try { assertProductionConfiguration(); } catch (error) {
    console.error(String(error));
    res.status(503).json({ error: true, status: 503, message: 'DimaFX production configuration invalid; operator action required' }); return;
  }
  const auth = req.header('authorization');
  const token = auth?.startsWith('Bearer ') ? auth.slice(7) : req.header('x-extension-jwt');
  if (!token) { res.status(401).json({ error: true, message: 'Missing Twitch Extension token', status: 401 }); return; }
  const allowUnverified = process.env.NODE_ENV !== 'production' && process.env.DIMAFX_ALLOW_UNVERIFIED_TWITCH_JWT === 'true';
  const payload = (signingSecret().length ? verifyTwitchJwt(token) : allowUnverified ? decode(token) : null) as TwitchExtensionJwtPayload | null;
  if (!payload || typeof payload.channel_id !== 'string' || !payload.channel_id || !validExpiration(payload.exp) ||
      (payload.user_id !== undefined && typeof payload.user_id !== 'string') ||
      (payload.opaque_user_id !== undefined && typeof payload.opaque_user_id !== 'string')) {
    res.status(401).json({ error: true, message: 'Invalid Twitch Extension token', status: 401 }); return;
  }
  req.extension = { channelID: payload.channel_id, userID: payload.user_id, opaqueUserID: payload.opaque_user_id, role: payload.role, token, identityShared: Boolean(payload.user_id) };
  next();
}
export function ensureChannelMatches(req: TwitchExtensionRequest, res: Response, channelID: string): boolean {
  if (req.extension?.channelID !== channelID) { res.status(403).json({ error: true, message: 'Extension channel mismatch', status: 403 }); return false; }
  return true;
}
