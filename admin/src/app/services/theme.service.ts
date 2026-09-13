import { DestroyRef, Injectable, inject, signal } from '@angular/core';

export const ADMIN_THEMES = [
  {
    id: 'green',
    name: 'Green',
    description: 'The original. Warm charcoal & lime.',
    accent: '#d3f892',
    canvas: '#101211',
  },
  {
    id: 'purple',
    name: 'Purple',
    description: 'Deep plum & soft lavender.',
    accent: '#cfb2ff',
    canvas: '#141018',
  },
  {
    id: 'blue',
    name: 'Blue',
    description: 'Midnight navy & clear blue.',
    accent: '#9fc8ff',
    canvas: '#0e131c',
  },
  {
    id: 'cyan',
    name: 'Cyan',
    description: 'Deep teal & bright cyan.',
    accent: '#89e4ed',
    canvas: '#0c1518',
  },
] as const;
export type AdminTheme = (typeof ADMIN_THEMES)[number]['id'];
const STORAGE_KEY = 'dima-admin.theme.v1';
function readTheme(): AdminTheme {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    return ADMIN_THEMES.find((theme) => theme.id === stored)?.id ?? 'green';
  } catch {
    return 'green';
  }
}
function applyTheme(theme: AdminTheme): void {
  document.documentElement.dataset['adminTheme'] = theme;
  document
    .querySelector('meta[name="theme-color"]')
    ?.setAttribute('content', ADMIN_THEMES.find((option) => option.id === theme)!.canvas);
}
// Apply the saved palette before Angular renders the first page.
export function restoreAdminTheme(): void {
  applyTheme(readTheme());
}

@Injectable({ providedIn: 'root' })
export class ThemeService {
  readonly themes = ADMIN_THEMES;
  readonly selected = signal<AdminTheme>(readTheme());
  constructor() {
    applyTheme(this.selected());
    const sync = (event: StorageEvent) => {
      if (event.key === STORAGE_KEY || event.key === null) {
        this.selected.set(readTheme());
        applyTheme(this.selected());
      }
    };
    window.addEventListener('storage', sync);
    inject(DestroyRef).onDestroy(() => window.removeEventListener('storage', sync));
  }
  select(theme: AdminTheme): void {
    this.selected.set(theme);
    applyTheme(theme);
    try {
      localStorage.setItem(STORAGE_KEY, theme);
    } catch {
      /* Still usable when storage is unavailable. */
    }
  }
}
