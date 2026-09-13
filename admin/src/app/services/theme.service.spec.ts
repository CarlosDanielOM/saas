import { vi } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { ThemeService, restoreAdminTheme } from './theme.service';

describe('Admin theme preference', () => {
  const key = 'dima-admin.theme.v1';
  beforeEach(() => {
    // Node 26 has a separate native localStorage; isolate browser preference tests.
    const values = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
    });
  });
  afterEach(() => {
    localStorage.removeItem(key);
    restoreAdminTheme();
    vi.unstubAllGlobals();
  });
  it('restores each saved theme before the application renders', () => {
    for (const theme of ['green', 'purple', 'blue', 'cyan']) {
      localStorage.setItem(key, theme);
      restoreAdminTheme();
      expect(document.documentElement.dataset['adminTheme']).toBe(theme);
    }
  });
  it('persists changes and responds to preference changes in another tab', () => {
    const service = TestBed.inject(ThemeService);
    service.select('cyan');
    expect(localStorage.getItem(key)).toBe('cyan');
    expect(document.documentElement.dataset['adminTheme']).toBe('cyan');
    localStorage.setItem(key, 'purple');
    window.dispatchEvent(new StorageEvent('storage', { key }));
    expect(service.selected()).toBe('purple');
    expect(document.documentElement.dataset['adminTheme']).toBe('purple');
  });
  it('falls back to green for an invalid saved preference', () => {
    localStorage.setItem(key, 'invalid');
    restoreAdminTheme();
    expect(document.documentElement.dataset['adminTheme']).toBe('green');
  });
});
