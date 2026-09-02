import { isPlatformBrowser } from '@angular/common';
import { PLATFORM_ID, afterNextRender, computed, effect, inject, Injectable, signal } from '@angular/core';

export type ThemePreference = 'light' | 'dark';

@Injectable({
  providedIn: 'root'
})
export class ThemeService {
  private readonly platformId = inject(PLATFORM_ID);
  private readonly isBrowser = isPlatformBrowser(this.platformId);
  private readonly storageKey = 'theme';

  // Deterministic default ('dark') is used for prerender/SSR so the server DOM
  // always matches the initial client render. The stored preference is applied
  // after hydration via afterNextRender to avoid hydration mismatches.
  readonly theme = signal<ThemePreference>('dark');
  readonly isDarkMode = computed(() => this.theme() === 'dark');

  constructor() {
    effect(() => {
      if (!this.isBrowser) {
        return;
      }

      const dark = this.isDarkMode();
      document.documentElement.classList.toggle('dark', dark);
      document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light');
    });

    afterNextRender(() => {
      this.theme.set(this.getStoredTheme());
    });
  }

  toggleTheme(): void {
    const next: ThemePreference = this.theme() === 'light' ? 'dark' : 'light';
    this.setTheme(next);
  }

  setTheme(theme: ThemePreference): void {
    this.theme.set(theme);
    if (this.isBrowser) {
      localStorage.setItem(this.storageKey, theme);
    }
  }

  private getStoredTheme(): ThemePreference {
    if (!this.isBrowser) {
      return 'dark';
    }

    const value = localStorage.getItem(this.storageKey);
    return value === 'light' || value === 'dark' ? value : 'dark';
  }
}
