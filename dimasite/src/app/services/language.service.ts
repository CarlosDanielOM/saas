import { isPlatformBrowser } from '@angular/common';
import { Injectable, PLATFORM_ID, afterNextRender, inject, signal } from '@angular/core';

import enDictionary from '../../assets/i18n/en.json';
import esDictionary from '../../assets/i18n/es.json';

export type SupportedLanguage = 'en' | 'es';
type TranslationLeaf = string | number | boolean | readonly unknown[];
type TranslationRecord = {
  [key: string]: TranslationLeaf | TranslationRecord;
};

@Injectable({
  providedIn: 'root'
})
export class LanguageService {
  private readonly platformId = inject(PLATFORM_ID);
  private readonly isBrowser = isPlatformBrowser(this.platformId);
  private readonly storageKey = 'userLanguage';
  private readonly defaultLanguage: SupportedLanguage = 'en';

  // The default language ('en') is used for prerender/SSR so the server DOM
  // always matches the initial client render. The stored/detected language is
  // applied after hydration via afterNextRender to avoid hydration mismatches.
  readonly currentLanguage = signal<SupportedLanguage>(this.defaultLanguage);
  private readonly dictionaries = signal<Record<SupportedLanguage, TranslationRecord>>({
    en: enDictionary as unknown as TranslationRecord,
    es: esDictionary as unknown as TranslationRecord
  });

  readonly availableLanguages = {
    en: { code: 'en', name: 'English', nativeName: 'English' },
    es: { code: 'es', name: 'Spanish', nativeName: 'Español' }
  } as const;

  constructor() {
    afterNextRender(() => {
      const initialLanguage = this.getStoredLanguage() ?? this.detectBrowserLanguage();
      this.currentLanguage.set(initialLanguage);
    });
  }

  translate(key: string, params?: Record<string, string | number>): string {
    const dictionaries = this.dictionaries();
    const activeLanguage = this.currentLanguage();
    const active = this.resolveKey(dictionaries[activeLanguage], key);
    const fallback = this.resolveKey(dictionaries[this.defaultLanguage], key);
    const raw = active ?? fallback ?? key;

    if (!params || typeof raw !== 'string') {
      return String(raw);
    }

    return Object.entries(params).reduce(
      (value, [paramKey, paramValue]) =>
        value.replaceAll(`{{${paramKey}}}`, String(paramValue)),
      raw
    );
  }

  getCurrentLanguage(): SupportedLanguage {
    return this.currentLanguage();
  }

  setLanguage(language: SupportedLanguage): void {
    this.currentLanguage.set(language);
    this.saveLanguage(language);
  }

  toggleLanguage(): void {
    this.setLanguage(this.currentLanguage() === 'en' ? 'es' : 'en');
  }

  getLanguageInfo(language: SupportedLanguage) {
    return this.availableLanguages[language];
  }

  getAvailableLanguages() {
    return Object.values(this.availableLanguages);
  }

  private resolveKey(dictionary: TranslationRecord, path: string): string | null {
    const value = path.split('.').reduce<unknown>((acc, part) => {
      if (acc && typeof acc === 'object' && part in acc) {
        return (acc as TranslationRecord)[part];
      }
      return undefined;
    }, dictionary);

    return typeof value === 'string' ? value : null;
  }

  private detectBrowserLanguage(): SupportedLanguage {
    if (!this.isBrowser) {
      return this.defaultLanguage;
    }

    const browser = navigator.language.toLowerCase();
    if (browser.startsWith('es')) {
      return 'es';
    }
    return 'en';
  }

  private getStoredLanguage(): SupportedLanguage | null {
    if (!this.isBrowser) {
      return null;
    }

    const value = localStorage.getItem(this.storageKey);
    return value === 'en' || value === 'es' ? value : null;
  }

  private saveLanguage(language: SupportedLanguage): void {
    if (this.isBrowser) {
      localStorage.setItem(this.storageKey, language);
    }
  }
}
