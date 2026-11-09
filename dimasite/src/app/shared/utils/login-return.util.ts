/**
 * Remembers the page a signed-out visitor tried to open (for example "View summary" in an
 * email), so the login page opens it after Twitch sign-in instead of the dashboard.
 *
 * Only route guards and pages write it, from the router's own URL, never from a query
 * parameter. localStorage (like the OAuth state) survives the Twitch round-trip even when
 * a phone hands the callback to a new tab; the short expiry keeps it from going stale.
 */
const KEY = 'dimasite.login-return.v1';
const TTL_MS = 30 * 60_000;
const MAX_LENGTH = 2048;
// The sign-in flow and error pages (root and in-channel 403) are never worth coming back to.
const SKIPPED = /^\/(?:login|oauth|401|403|404|500|503|[^/?#]+\/403)(?:[/?#]|$)/;

/** A same-site app path, or null. Rejects `//host` and `/\host` so it can't leave the site. */
export function safeLoginReturn(path: string | null | undefined): string | null {
  const value = path?.trim() ?? '';
  if (
    !value.startsWith('/') ||
    value.startsWith('//') ||
    value.startsWith('/\\') ||
    value.length > MAX_LENGTH ||
    /[\u0000-\u001f\u007f]/.test(value) ||
    value === '/' ||
    SKIPPED.test(value)
  ) {
    return null;
  }
  return value;
}

export function rememberLoginReturn(path: string): void {
  const safe = safeLoginReturn(path);
  if (!safe) {
    return;
  }
  try {
    localStorage.setItem(KEY, JSON.stringify({ path: safe, expires: Date.now() + TTL_MS }));
  } catch {
    // Storage blocked: sign-in still works and opens the dashboard.
  }
}

/** Reads and clears the remembered page; null when there is none or it expired. */
export function consumeLoginReturn(): string | null {
  try {
    const raw = localStorage.getItem(KEY);
    localStorage.removeItem(KEY);
    const value = JSON.parse(raw || 'null') as { path?: unknown; expires?: unknown } | null;
    return value && typeof value.path === 'string' && typeof value.expires === 'number' && value.expires > Date.now()
      ? safeLoginReturn(value.path)
      : null;
  } catch {
    return null;
  }
}

/** For sign-ins that go somewhere else on purpose (checkout, OAuth consent), so a later login isn't hijacked. */
export function clearLoginReturn(): void {
  consumeLoginReturn();
}
