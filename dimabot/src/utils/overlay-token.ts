import { createHash, randomBytes } from 'node:crypto';
import { decrypt, encrypt } from './crypto.js';

export interface OverlayTokenDocument {
  tokenHash: string | null;
  overlayToken?: { iv: string; content: string } | null;
}
export interface OverlayTokenState { token: string | null; exists: boolean; version: string | null }
export interface OverlayTokenStore {
  read(): Promise<OverlayTokenDocument>;
  save(expectedHash: string | null, token: string, replace: boolean): Promise<boolean>;
}
type Fail = (code: string, message: string, status?: number) => never;
export const overlayTokenHash = (token: string) => createHash('sha256').update(token).digest('hex');
export const storedOverlayToken = (token: string) => ({ tokenHash: overlayTokenHash(token), overlayToken: encrypt(token) });

function state(doc: OverlayTokenDocument): OverlayTokenState {
  let token: string | null = null;
  try { token = doc.overlayToken ? decrypt(doc.overlayToken) : null; } catch { /* An existing OBS URL can be saved again. */ }
  if (!token || overlayTokenHash(token) !== doc.tokenHash) token = null;
  return { token, exists: !!doc.tokenHash, version: doc.tokenHash ?? null };
}
export async function readOverlayToken(store: OverlayTokenStore): Promise<OverlayTokenState> { return state(await store.read()); }

/** Creation is idempotent. Replacement requires the version the user confirmed. */
export async function manageOverlayToken(store: OverlayTokenStore, input: unknown, fail: Fail): Promise<OverlayTokenState> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('invalid', 'Invalid overlay link request');
  const body = input as Record<string, unknown>;
  if (Object.keys(body).some(key => !['rotate', 'version', 'token'].includes(key)) ||
      (body.rotate !== undefined && typeof body.rotate !== 'boolean') || (body.rotate && body.token !== undefined)) fail('invalid', 'Invalid overlay link request');
  if (body.token !== undefined && (typeof body.token !== 'string' || !/^[\w-]{43}$/.test(body.token))) fail('invalid', 'Invalid overlay token');
  for (let attempt = 0; attempt < 8; attempt++) {
    const doc = await store.read();
    if (body.token !== undefined) {
      const token = body.token as string;
      if (!doc.tokenHash || overlayTokenHash(token) !== doc.tokenHash) fail('overlay_link_invalid', 'This link is no longer active', 409);
      if (await store.save(doc.tokenHash, token, false)) return state({ ...doc, ...storedOverlayToken(token) });
    } else {
      if (!body.rotate && doc.tokenHash) {
        const current = state(doc);
        if (!current.token) fail('overlay_link_recovery_required', 'Save the existing OBS link before retrieving it', 409);
        return current;
      }
      if (body.rotate && body.version !== (doc.tokenHash ?? null)) fail('overlay_link_conflict', 'The overlay link changed; reload before replacing it', 409);
      const token = randomBytes(32).toString('base64url');
      if (await store.save(doc.tokenHash ?? null, token, true)) return state({ ...doc, ...storedOverlayToken(token) });
      if (body.rotate) fail('overlay_link_conflict', 'The overlay link changed; reload before replacing it', 409);
    }
  }
  return fail('overlay_link_conflict', 'The overlay link changed; reload before trying again', 409);
}

/** Upgrade a hash-only legacy URL after successful overlay authentication. */
export async function rememberOverlayToken(store: OverlayTokenStore, token: string): Promise<void> {
  const doc = await store.read();
  if (doc.tokenHash === overlayTokenHash(token) && !state(doc).token) await store.save(doc.tokenHash, token, false);
}
