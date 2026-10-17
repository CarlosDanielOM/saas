const key = 'dimasite.oauth.return.v1';
const allowed = (path: string) => path === '/oauth/connections' || /^\/oauth\/authorize\?request=[A-Za-z0-9_-]{43}$/.test(path);

/** Only fixed local OAuth routes can resume after the existing website login. */
export function rememberOAuthReturn(path: string): void {
  if (allowed(path)) sessionStorage.setItem(key, JSON.stringify({ path, expires: Date.now() + 600_000 }));
}

export function consumeOAuthReturn(): string | null {
  const raw = sessionStorage.getItem(key);
  sessionStorage.removeItem(key);
  try {
    const value = JSON.parse(raw || 'null') as { path?: unknown; expires?: unknown } | null;
    return value && typeof value.path === 'string' && allowed(value.path) &&
      typeof value.expires === 'number' && value.expires > Date.now() ? value.path : null;
  } catch { return null; }
}
