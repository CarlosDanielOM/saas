/**
 * Per-browser switches for unfinished UI the team wants to try before anyone else sees it.
 * Turn on: open any page with `?experiments=<name>[,<name>…]` (remembered in this browser).
 * Turn off: open any page with `?experiments=`.
 * UI only: never gate data access, limits or security on an experiment.
 */
export const EXPERIMENTS = [
  /** Import dialog lists the values a custom widget reads but the settings panel doesn't show. */
  'widget-built-in-values'
] as const;
export type Experiment = typeof EXPERIMENTS[number];
const STORAGE_KEY = 'dimasite.experiments';

/** Saves `?experiments=` from the address bar. Runs once at startup, before the router can drop the query. */
export function rememberExperiments(): void {
  if (typeof window === 'undefined') return;
  try {
    const param = new URLSearchParams(window.location.search).get('experiments');
    if (param === null) return;
    const names = param.split(',').map(name => name.trim()).filter(name => (EXPERIMENTS as readonly string[]).includes(name));
    if (names.length) localStorage.setItem(STORAGE_KEY, names.join(','));
    else localStorage.removeItem(STORAGE_KEY);
  } catch { /* storage blocked: experiments stay off */ }
}

export function experimentEnabled(name: Experiment): boolean {
  if (typeof window === 'undefined') return false;
  try { return (localStorage.getItem(STORAGE_KEY) ?? '').split(',').includes(name); } catch { return false; }
}
