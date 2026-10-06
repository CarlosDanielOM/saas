const TWITCH_LOGIN = /^[a-z0-9_]{1,25}$/;
const TWITCH_HOST = /^(?:https?:\/\/)?(?:www\.|m\.)?twitch\.tv\//i;

/** Where the return page finds the gift if Polar's redirect loses the `gift_id` param. */
export const PENDING_GIFT_STORAGE_KEY = 'dimasite.pendingGiftId';

/**
 * Seconds between status checks after returning from checkout. Bounded on
 * purpose (~1.5 minutes): after that the page offers a manual "Check again".
 */
export const GIFT_POLL_DELAYS_MS: readonly number[] = [
  0, 2000, 3000, 4000, 5000, 8000, 10000, 15000, 20000, 30000
];

/**
 * Turns what people paste ("@Dima", "twitch.tv/dima", "https://www.twitch.tv/dima/videos")
 * into an exact Twitch login, or null when it can't be one.
 */
export function normalizeChannelLogin(raw: string): string | null {
  let value = raw.trim();
  if (TWITCH_HOST.test(value)) {
    value = value.replace(TWITCH_HOST, '').split(/[/?#]/)[0] ?? '';
  }
  value = value.replace(/^@+/, '').trim().toLowerCase();
  return TWITCH_LOGIN.test(value) ? value : null;
}

/** Idempotency key for one gift intent (pack + recipient). */
export function createGiftRequestId(): string {
  const cryptoApi = globalThis.crypto;
  if (typeof cryptoApi?.randomUUID === 'function') {
    return cryptoApi.randomUUID();
  }
  const bytes = cryptoApi.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** HTTP status and API message from an HttpErrorResponse or a failed envelope. */
export function readApiError(error: unknown): { status: number | null; message: string | null } {
  if (!error || typeof error !== 'object') {
    return { status: null, message: null };
  }
  const record = error as { status?: unknown; message?: unknown; error?: unknown };
  const body = record.error && typeof record.error === 'object'
    ? (record.error as { message?: unknown; status?: unknown })
    : null;
  const status = typeof record.status === 'number' && record.status > 0
    ? record.status
    : typeof body?.status === 'number' ? body.status : null;
  const message = typeof body?.message === 'string' && body.message.trim()
    ? body.message.trim()
    : null;
  return { status, message };
}
