/**
 * This page's build: the hash of the site's main bundle (`main-<HASH>.js`). Each release whose code changed gets a new
 * hash, so it identifies the release with no build step. `dev` on the dev server (no hashed bundle).
 * OBS overlay pages and Overlay Studio saves send it to the API, which shows the versions in use in the admin site.
 */
export function siteBuild(doc: Pick<Document, 'querySelector'> | null = typeof document === 'undefined' ? null : document): string {
  const src = doc?.querySelector<HTMLScriptElement>('script[type="module"][src*="main-"]')?.src ?? '';
  const hash = /\/main-([A-Za-z0-9]{6,32})\.js(?:$|[?#])/.exec(src)?.[1];
  return hash ? `main-${hash}` : 'dev';
}
