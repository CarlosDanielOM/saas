import { DestroyRef, Injectable, inject, signal } from '@angular/core';

export const ADMIN_MODES = [
  { id: 'system', name: 'Match device', description: 'Light or dark, following this device.' },
  { id: 'light', name: 'Light', description: 'Bright tiles on a soft grey background.' },
  { id: 'dark', name: 'Dark', description: 'Easy on the eyes at night.' },
] as const;

export const ADMIN_ACCENTS = [
  { id: 'violet', name: 'Violet', description: 'The Dima colour.', swatch: '#7c3aed' },
  { id: 'green', name: 'Green', description: 'The original admin colour.', swatch: '#15803d' },
  { id: 'blue', name: 'Blue', description: 'Calm and clear.', swatch: '#1d4ed8' },
  { id: 'cyan', name: 'Cyan', description: 'Bright teal.', swatch: '#0e7490' },
] as const;

export type AdminMode = (typeof ADMIN_MODES)[number]['id'];
export type AdminAccent = (typeof ADMIN_ACCENTS)[number]['id'];

const MODE_KEY = 'dima-admin.mode.v1';
const ACCENT_KEY = 'dima-admin.accent.v1';
/** Pre-Live First palette key; read once so an earlier choice carries over. */
const LEGACY_THEME_KEY = 'dima-admin.theme.v1';

function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function readMode(): AdminMode {
  const stored = read(MODE_KEY);
  return ADMIN_MODES.find((mode) => mode.id === stored)?.id ?? 'dark';
}

function readAccent(): AdminAccent {
  const stored = read(ACCENT_KEY) ?? (read(LEGACY_THEME_KEY) === 'purple' ? 'violet' : read(LEGACY_THEME_KEY));
  return ADMIN_ACCENTS.find((accent) => accent.id === stored)?.id ?? 'violet';
}

function prefersDark(): boolean {
  return typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: dark)').matches;
}

function apply(mode: AdminMode, accent: AdminAccent): void {
  const dark = mode === 'dark' || (mode === 'system' && prefersDark());
  const root = document.documentElement;
  root.classList.toggle('dark', dark);
  root.dataset['theme'] = dark ? 'dark' : 'light';
  root.dataset['accent'] = accent;
  root.style.colorScheme = dark ? 'dark' : 'light';
  document
    .querySelector('meta[name="theme-color"]')
    ?.setAttribute('content', dark ? '#0f1115' : '#f4f5f8');
}

// Apply the saved appearance before Angular renders the first page.
export function restoreAdminTheme(): void {
  apply(readMode(), readAccent());
}

@Injectable({ providedIn: 'root' })
export class ThemeService {
  readonly modes = ADMIN_MODES;
  readonly accents = ADMIN_ACCENTS;
  readonly mode = signal<AdminMode>(readMode());
  readonly accent = signal<AdminAccent>(readAccent());
  readonly isDark = signal(document.documentElement.classList.contains('dark'));

  constructor() {
    this.sync();
    const onStorage = (event: StorageEvent) => {
      if (event.key === MODE_KEY || event.key === ACCENT_KEY || event.key === null) {
        this.mode.set(readMode());
        this.accent.set(readAccent());
        this.sync();
      }
    };
    const media = typeof matchMedia === 'function' ? matchMedia('(prefers-color-scheme: dark)') : null;
    const onScheme = () => this.mode() === 'system' && this.sync();
    window.addEventListener('storage', onStorage);
    media?.addEventListener?.('change', onScheme);
    inject(DestroyRef).onDestroy(() => {
      window.removeEventListener('storage', onStorage);
      media?.removeEventListener?.('change', onScheme);
    });
  }

  setMode(mode: AdminMode): void {
    this.mode.set(mode);
    this.save(MODE_KEY, mode);
    this.sync();
  }

  setAccent(accent: AdminAccent): void {
    this.accent.set(accent);
    this.save(ACCENT_KEY, accent);
    this.sync();
  }

  /** Quick toggle from the navbar: flips whatever is showing now. */
  toggleDark(): void {
    this.setMode(this.isDark() ? 'light' : 'dark');
  }

  private sync(): void {
    apply(this.mode(), this.accent());
    this.isDark.set(document.documentElement.classList.contains('dark'));
  }

  private save(key: string, value: string): void {
    try {
      localStorage.setItem(key, value);
    } catch {
      /* Still usable when storage is unavailable. */
    }
  }
}
