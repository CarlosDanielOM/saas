import { computed, effect, Injectable, signal } from '@angular/core';

export type ThemePreference = 'light' | 'dark';

@Injectable({
  providedIn: 'root'
})
export class ThemeService {
  private readonly storageKey = 'theme';
  readonly theme = signal<ThemePreference>(this.getStoredTheme());
  readonly isDarkMode = computed(() => this.theme() === 'dark');

  constructor() {
    effect(() => {
      const dark = this.isDarkMode();
      document.documentElement.classList.toggle('dark', dark);
      document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light');
    });
  }

  toggleTheme(): void {
    const next: ThemePreference = this.theme() === 'light' ? 'dark' : 'light';
    this.setTheme(next);
  }

  setTheme(theme: ThemePreference): void {
    this.theme.set(theme);
    localStorage.setItem(this.storageKey, theme);
  }

  private getStoredTheme(): ThemePreference {
    const value = localStorage.getItem(this.storageKey);
    return value === 'light' || value === 'dark' ? value : 'dark';
  }
}
