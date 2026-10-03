import { vi } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { ThemeService, restoreAdminTheme } from './theme.service';

describe('Admin appearance preference', () => {
  let values: Map<string, string>;
  beforeEach(() => {
    // Node 26 has a separate native localStorage; isolate browser preference tests.
    values = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
    });
  });
  afterEach(() => {
    values.clear();
    restoreAdminTheme();
    vi.unstubAllGlobals();
  });

  it('defaults to dark mode with the violet accent', () => {
    restoreAdminTheme();
    expect(document.documentElement.classList.contains('dark')).toBe(true);
    expect(document.documentElement.dataset['accent']).toBe('violet');
  });

  it('restores saved mode and accent before the application renders', () => {
    localStorage.setItem('dima-admin.mode.v1', 'light');
    for (const accent of ['violet', 'green', 'blue', 'cyan']) {
      localStorage.setItem('dima-admin.accent.v1', accent);
      restoreAdminTheme();
      expect(document.documentElement.dataset['accent']).toBe(accent);
      expect(document.documentElement.classList.contains('dark')).toBe(false);
      expect(document.documentElement.dataset['theme']).toBe('light');
    }
  });

  it('carries over a palette picked before the redesign', () => {
    localStorage.setItem('dima-admin.theme.v1', 'purple');
    restoreAdminTheme();
    expect(document.documentElement.dataset['accent']).toBe('violet');
    localStorage.setItem('dima-admin.theme.v1', 'cyan');
    restoreAdminTheme();
    expect(document.documentElement.dataset['accent']).toBe('cyan');
  });

  it('persists changes and responds to preference changes in another tab', () => {
    const service = TestBed.inject(ThemeService);
    service.setAccent('cyan');
    service.setMode('light');
    expect(localStorage.getItem('dima-admin.accent.v1')).toBe('cyan');
    expect(localStorage.getItem('dima-admin.mode.v1')).toBe('light');
    expect(document.documentElement.classList.contains('dark')).toBe(false);
    service.toggleDark();
    expect(service.isDark()).toBe(true);
    localStorage.setItem('dima-admin.accent.v1', 'blue');
    window.dispatchEvent(new StorageEvent('storage', { key: 'dima-admin.accent.v1' }));
    expect(service.accent()).toBe('blue');
    expect(document.documentElement.dataset['accent']).toBe('blue');
  });

  it('falls back to the defaults for invalid saved values', () => {
    localStorage.setItem('dima-admin.accent.v1', 'invalid');
    localStorage.setItem('dima-admin.mode.v1', 'neon');
    restoreAdminTheme();
    expect(document.documentElement.dataset['accent']).toBe('violet');
    expect(document.documentElement.classList.contains('dark')).toBe(true);
  });
});
