# Landing Page Implementation Plan
**DomDimaBot v21 - Phase 1**

---

## Overview

This plan covers the complete implementation of the landing page for the new v21 DomDimaBot website. The landing page will be the entry point for all users, featuring a modern purple-themed design, live analytics, smooth animations, and optional Three.js enhancements.

**Target:** `/home/cdom/saas/dimasite/`
**Reference:** `/home/cdom/saas/dima-site/`
**Angular Version:** v21
**Implementation Status:** Landing page only (Phases 1-3 of full plan)

---

## Project Structure

```
dimasite/
├── src/
│   ├── app/
│   │   ├── features/
│   │   │   └── landing/
│   │   │       ├── landing-page.component.ts
│   │   │       ├── landing-page.component.html
│   │   │       └── landing-page.component.css
│   │   ├── core/
│   │   │   ├── services/
│   │   │   │   ├── language.service.ts
│   │   │   │   ├── theme.service.ts
│   │   │   │   ├── websocket.service.ts
│   │   │   │   └── links.service.ts
│   │   │   └── models/
│   │   │       └── site-stats.model.ts
│   │   ├── shared/
│   │   │   └── directives/
│   │   │       └── count-up.directive.ts
│   │   ├── app.config.ts
│   │   ├── app.routes.ts
│   │   ├── app.ts
│   │   ├── app.html
│   │   └── app.css
│   ├── assets/
│   │   ├── i18n/
│   │   │   ├── en.json
│   │   │   └── es.json
│   │   └── images/
│   │       └── favicon.ico
│   ├── environments/
│   │   ├── environment.ts
│   │   └── environment.development.ts
│   ├── index.html
│   ├── main.ts
│   └── styles.css
├── tailwind.config.js
├── package.json
└── angular.json
```

---

## Phase 1: Configuration & Infrastructure

### 1.1 Package Installation

**Install ngx-translate packages:**
```bash
cd /home/cdom/saas/dimasite
npm install @ngx-translate/core @ngx-translate/http-loader
```

**Verify existing packages:**
- `three@0.183.2` ✓ (already installed)
- `lucide-angular@^0.577.0` ✓ (already installed)
- `ngx-socket-io@^4.10.0` ✓ (already installed)
- `@angular/forms@^21.1.0` ✓ (already installed)

### 1.2 Tailwind Configuration

**Create `/home/cdom/saas/dimasite/tailwind.config.js`:**

```javascript
/** @type {import('tailwindcss').Config} */
export default {
  content: ["./src/**/*.{html,ts}"],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        primary: {
          400: '#a78bfa',
          500: '#8b5cf6',
          600: '#7c3aed',
        },
        secondary: {
          400: '#c084fc',
          500: '#a855f7',
        }
      },
      animation: {
        'aurora-drift': 'aurora-drift 26s ease-in-out infinite',
        'gradient-shift': 'gradient-shift 12s ease infinite',
        'pulse-slow': 'pulse 3s cubic-bezier(0.4, 0, 0.6, 1) infinite',
      },
      keyframes: {
        'aurora-drift': {
          '0%, 100%': { transform: 'translate3d(0, 0, 0) scale(1) rotate(0deg)' },
          '50%': { transform: 'translate3d(8%, -6%, 0) scale(1.08) rotate(10deg)' },
        },
        'gradient-shift': {
          '0%, 100%': { backgroundPosition: '0% 50%' },
          '50%': { backgroundPosition: '100% 50%' },
        },
      }
    }
  },
  safelist: [
    // Critical spacing utilities
    'space-x-1', 'space-x-2', 'space-x-3', 'space-x-4', 'space-x-6',
    'space-y-1', 'space-y-2', 'space-y-3', 'space-y-4', 'space-y-6',
    'gap-1', 'gap-2', 'gap-3', 'gap-4', 'gap-6',
    'gap-8', 'gap-10', 'gap-12',
    // Padding utilities
    'p-4', 'p-6', 'px-4', 'px-6', 'py-2', 'py-12',
    'py-24', 'py-32', 'py-48',
    // Margin utilities
    'mb-2', 'mb-12', 'mt-4', 'mt-6', 'mt-8',
    'max-w-[600px]', 'max-w-[700px]', 'max-w-[sm]',
    // Text utilities
    'text-2xl', 'text-3xl', 'text-4xl', 'text-5xl', 'text-6xl',
    'text-xl',
  ]
};
```

### 1.3 Environment Configuration

**Create `/home/cdom/saas/dimasite/src/environments/environment.ts`:**
```typescript
export const environment = {
  production: true,
  POSTHOG_KEY: "phc_ApcLd2XbNHavPCcyD9fFDVHxs7cCBPozWmSBFTqugfP",
  POSTHOG_HOST: "https://us.i.posthog.com",
  DIMA_API: "https://api.domdimabot.com",
  CLIENT_ID: "jl9k3mi67pmrbl1bh67y07ezjdc4cf",
  TWITCH_API: "https://api.twitch.tv/helix",
  DISCORD_URL: "https://discord.gg/HdubYrkPXt"
};
```

**Create `/home/cdom/saas/dimasite/src/environments/environment.development.ts`:**
```typescript
export const environment = {
  production: false,
  POSTHOG_KEY: "phc_ApcLd2XbNHavPCcyD9fFDVHxs7cCBPozWmSBFTqugfP",
  POSTHOG_HOST: "https://us.i.posthog.com",
  DIMA_API: "http://localhost:3000",
  CLIENT_ID: "jl9k3mi67pmrbl1bh67y07ezjdc4cf",
  TWITCH_API: "https://api.twitch.tv/helix",
  DISCORD_URL: "https://discord.gg/HdubYrkPXt"
};
```

### 1.4 Global Styles

**Update `/home/cdom/saas/dimasite/src/styles.css`:**

```css
@import "tailwindcss";

/* CSS Variables for theming */
:root {
  --color-primary: #8b5cf6;
  --color-primary-dark: #7c3aed;
  --color-primary-light: #a78bfa;
  --color-secondary: #a855f7;
  --color-accent: #c4b5fd;
  --transition-fast: 0.2s cubic-bezier(0.4, 0, 0.2, 1);
  --transition-base: 0.3s cubic-bezier(0.4, 0, 0.2, 1);
  --transition-slow: 0.5s cubic-bezier(0.4, 0, 0.2, 1);
}

/* Light mode colors */
:root {
  --color-surface: #fafafa;
  --color-surface-alt: #f4f4f5;
  --color-surface-elevated: #ffffff;
  --color-text: #27272a;
  --color-text-muted: #71717a;
  --color-text-light: #a1a1aa;
  --color-border: #e4e4e7;
  --color-border-subtle: #f4f4f5;
}

/* Dark mode colors */
.dark {
  --color-surface: #18181b;
  --color-surface-alt: #27272a;
  --color-surface-elevated: #27272a;
  --color-text: #fafafa;
  --color-text-muted: #a1a1aa;
  --color-text-light: #71717a;
  --color-border: #3f3f46;
  --color-border-subtle: #27272a;
}

/* Base styles */
html {
  scroll-behavior: smooth;
}

body {
  margin: 0;
  background-color: var(--color-surface);
  color: var(--color-text);
  transition: background-color var(--transition-base), color var(--transition-base);
}

/* Aurora blob animations */
@keyframes aurora-drift {
  0% {
    transform: translate3d(0, 0, 0) scale(1) rotate(0deg);
  }
  50% {
    transform: translate3d(8%, -6%, 0) scale(1.08) rotate(10deg);
  }
  100% {
    transform: translate3d(-6%, 4%, 0) scale(1.02) rotate(-8deg);
  }
}

/* Gradient text animation */
@keyframes gradient-shift {
  0% { background-position: 0% 50%; }
  50% { background-position: 100% 50%; }
  100% { background-position: 0% 50%; }
}

/* Glassmorphism cards */
.glass-card {
  background: rgba(255, 255, 255, 0.7);
  backdrop-filter: saturate(140%) blur(14px);
  -webkit-backdrop-filter: saturate(140%) blur(14px);
  border: 1px solid rgba(255, 255, 255, 0.35);
  box-shadow: 0 10px 30px rgba(124, 58, 237, 0.08);
}

.dark .glass-card {
  background: rgba(39, 39, 42, 0.7);
  border: 1px solid rgba(124, 58, 237, 0.2);
}

/* Scroll reveal animations */
.reveal-init {
  opacity: 0;
  transform: translateY(24px) scale(0.98);
}

.reveal-in {
  opacity: 1;
  transform: none;
  transition: transform 800ms cubic-bezier(0.22, 1, 0.36, 1), opacity 800ms ease;
}

/* Utility classes */
.gradient-text {
  background: linear-gradient(90deg, #7e22ce, #a855f7, #3b82f6, #1d4ed8);
  background-size: 300% 300%;
  -webkit-background-clip: text;
  background-clip: text;
  color: transparent;
  animation: gradient-shift 12s ease infinite;
}

.btn-gradient {
  background-image: linear-gradient(135deg, #7e22ce 0%, #a855f7 33%, #3b82f6 66%, #1d4ed8 100%);
  background-size: 320% 320%;
  color: #fff;
  border-radius: 0.75rem;
  padding: 1rem 1.5rem;
  box-shadow: 0 10px 20px rgba(124,58,237,0.25);
  transition: transform 250ms ease, box-shadow 250ms ease, filter 250ms ease;
  animation: gradient-shift 6s ease infinite;
  display: inline-flex;
  align-items: center;
  gap: 0.5rem;
  font-weight: 600;
}

.btn-gradient:hover {
  transform: translateY(-2px);
  box-shadow: 0 16px 32px rgba(124,58,237,0.35);
  filter: brightness(1.05);
}

.btn-outline-gradient {
  position: relative;
  border: 2px solid transparent;
  background-image: linear-gradient(var(--color-surface-elevated), var(--color-surface-elevated)),
                    linear-gradient(135deg, #7e22ce, #a855f7, #3b82f6, #1d4ed8);
  background-origin: border-box;
  background-clip: padding-box, border-box;
  border-radius: 0.75rem;
  padding: 1rem 1.25rem;
  color: #7e22ce;
  transition: transform 250ms ease, box-shadow 250ms ease, background 250ms ease;
  font-weight: 600;
  display: inline-flex;
  align-items: center;
  gap: 0.5rem;
}

.dark .btn-outline-gradient {
  color: #a78bfa;
}

.btn-outline-gradient:hover {
  transform: translateY(-2px);
  box-shadow: 0 12px 24px rgba(124,58,237,0.15);
}

/* Aurora blobs */
.aurora-blob {
  position: absolute;
  border-radius: 9999px;
  filter: blur(80px);
  opacity: 0.55;
  will-change: transform, opacity;
  animation-name: aurora-drift;
  animation-timing-function: ease-in-out;
  animation-iteration-count: infinite;
  pointer-events: none;
}

.blob-1 {
  top: -10%;
  left: -8%;
  width: 48rem;
  height: 48rem;
  background: radial-gradient(
    circle at 30% 30%,
    rgba(126,34,206,0.55) 0%,
    rgba(168,85,247,0.40) 40%,
    rgba(59,130,246,0.32) 70%,
    rgba(29,78,216,0.22) 100%
  );
  animation-duration: 26s;
}

.blob-2 {
  right: -12%;
  bottom: -18%;
  width: 56rem;
  height: 56rem;
  background: radial-gradient(
    circle at 70% 70%,
    rgba(59,130,246,0.42) 0%,
    rgba(168,85,247,0.36) 45%,
    rgba(59,130,246,0.30) 75%,
    rgba(29,78,216,0.24) 100%
  );
  animation-duration: 30s;
}

.blob-3 {
  top: 35%;
  right: 8%;
  width: 36rem;
  height: 36rem;
  background: radial-gradient(
    circle at 50% 50%,
    rgba(126,34,206,0.40) 0%,
    rgba(168,85,247,0.32) 35%,
    rgba(59,130,246,0.28) 70%,
    rgba(29,78,216,0.22) 100%
  );
  animation-duration: 28s;
}

/* Parallax layers */
.parallax-layer {
  position: absolute;
  inset: 0;
  pointer-events: none;
  will-change: transform;
  transform: translate3d(0, 0, 0);
}

/* Sticky navbar */
.sticky-navbar {
  position: sticky;
  top: 0;
  z-index: 50;
  transition: background-color 0.3s ease, backdrop-filter 0.3s ease;
  backdrop-filter: blur(0px);
  background-color: transparent;
}

.sticky-navbar.scrolled {
  backdrop-filter: blur(10px);
  background-color: rgba(233, 213, 255, 0.7);
  border-bottom: 1px solid rgba(196, 181, 253, 0.3);
}

.dark .sticky-navbar.scrolled {
  background-color: rgba(24, 24, 27, 0.8);
  border-bottom: 1px solid rgba(124, 58, 237, 0.3);
}

/* Card hover effects */
.card-hover {
  transition: transform 350ms cubic-bezier(0.22, 1, 0.36, 1), box-shadow 350ms ease;
}

.card-hover:hover {
  transform: translateY(-6px) scale(1.01);
  box-shadow: 0 16px 40px rgba(124, 58, 237, 0.15);
}

/* Icon glow */
.glow-icon {
  filter: drop-shadow(0 10px 20px rgba(124,58,237,0.25)) saturate(1.2);
}

/* Count-up animation styles */
[countUp] {
  display: inline-block;
  transition: transform 0.3s ease-out;
  will-change: transform;
}

[countUp].counting {
  animation: count-pulse 0.6s ease-in-out infinite;
}

@keyframes count-pulse {
  0% { transform: scale(1); }
  50% { transform: scale(1.05); }
  100% { transform: scale(1); }
}

.stats-number {
  transition: all 0.3s ease-out;
  font-weight: 700;
  letter-spacing: -0.02em;
}

.stats-number.counting {
  text-shadow: 0 0 8px rgba(124, 58, 237, 0.3);
  color: #7c3aed;
}

.dark .stats-number.counting {
  color: #a78bfa;
}
```

### 1.5 HTML Configuration

**Update `/home/cdom/saas/dimasite/src/index.html`:**

```html
<!doctype html>
<html lang="en" class="scroll-smooth">
<head>
  <meta charset="utf-8">
  <title>DomDimaBot - Your Ultimate Twitch Chat Companion</title>
  <base href="/">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="description" content="Enhance your Twitch streaming experience with DomDimaBot. Engage your audience, moderate chats, and boost your channel interactivity.">
  <link rel="icon" type="image/svg+xml" href="favicon.svg">
  <link rel="icon" type="image/x-icon" href="favicon.ico">
  <link href="https://fonts.googleapis.com/css2?family=Material+Symbols+Outlined" rel="stylesheet" />
</head>
<body>
  <app-root></app-root>
</body>
</html>
```

---

## Phase 2: Core Services

### 2.1 Language Service (i18n)

**Create `/home/cdom/saas/dimasite/src/app/core/services/language.service.ts`:**

```typescript
import { Injectable, signal, inject } from '@angular/core';
import { TranslateService } from '@ngx-translate/core';
import { HttpClient } from '@angular/common/http';
import { TranslateHttpLoader } from '@ngx-translate/http-loader';

export type SupportedLanguage = 'en' | 'es';

export function HttpLoaderFactory(http: HttpClient) {
  return new TranslateHttpLoader(http, './assets/i18n/', '.json');
}

@Injectable({
  providedIn: 'root'
})
export class LanguageService {
  private readonly STORAGE_KEY = 'userLanguage';
  private readonly DEFAULT_LANGUAGE: SupportedLanguage = 'en';
  private translateService = inject(TranslateService);

  // Available languages with their display names
  readonly availableLanguages = {
    en: { code: 'en', name: 'English', nativeName: 'English' },
    es: { code: 'es', name: 'Spanish', nativeName: 'Español' }
  } as const;

  // Current language signal
  currentLanguage = signal<SupportedLanguage>(this.DEFAULT_LANGUAGE);

  constructor() {
    this.initializeLanguage();
  }

  private initializeLanguage(): void {
    const storedLanguage = this.getStoredLanguage();

    if (storedLanguage && this.isValidLanguage(storedLanguage)) {
      this.currentLanguage.set(storedLanguage);
      this.translateService.use(storedLanguage);
      console.log('Language set from localStorage:', storedLanguage);
    } else {
      const browserLanguage = this.detectBrowserLanguage();
      this.currentLanguage.set(browserLanguage);
      this.translateService.use(browserLanguage);
      this.saveLanguageToStorage(browserLanguage);
      console.log('Language set from browser preference:', browserLanguage);
    }

    // Set default language
    this.translateService.setDefaultLang(this.DEFAULT_LANGUAGE);
  }

  private detectBrowserLanguage(): SupportedLanguage {
    const browserLang = navigator.language.toLowerCase();

    if (browserLang === 'en' || browserLang.startsWith('en-')) {
      return 'en';
    }
    if (browserLang === 'es' || browserLang.startsWith('es-')) {
      return 'es';
    }

    if (browserLang.includes('en')) {
      return 'en';
    }
    if (browserLang.includes('es')) {
      return 'es';
    }

    return this.DEFAULT_LANGUAGE;
  }

  private getStoredLanguage(): SupportedLanguage | null {
    try {
      const stored = localStorage.getItem(this.STORAGE_KEY);
      return stored as SupportedLanguage;
    } catch (error) {
      console.warn('Could not read language from localStorage:', error);
      return null;
    }
  }

  private saveLanguageToStorage(language: SupportedLanguage): void {
    try {
      localStorage.setItem(this.STORAGE_KEY, language);
    } catch (error) {
      console.warn('Could not save language to localStorage:', error);
    }
  }

  private isValidLanguage(lang: string): lang is SupportedLanguage {
    return lang === 'en' || lang === 'es';
  }

  getCurrentLanguage(): SupportedLanguage {
    return this.currentLanguage();
  }

  setLanguage(language: SupportedLanguage): void {
    if (!this.isValidLanguage(language)) {
      console.warn(`Unsupported language: ${language}. Using default.`);
      language = this.DEFAULT_LANGUAGE;
    }

    this.currentLanguage.set(language);
    this.translateService.use(language);
    this.saveLanguageToStorage(language);
    console.log('Language changed to:', language);
  }

  toggleLanguage(): void {
    const current = this.getCurrentLanguage();
    const newLanguage = current === 'en' ? 'es' : 'en';
    this.setLanguage(newLanguage);
  }

  getLanguageInfo(language: SupportedLanguage) {
    return this.availableLanguages[language];
  }

  getAvailableLanguages() {
    return Object.values(this.availableLanguages);
  }
}
```

### 2.2 Theme Service

**Create `/home/cdom/saas/dimasite/src/app/core/services/theme.service.ts`:**

```typescript
import { Injectable, signal } from '@angular/core';
import { inject } from '@angular/core';

@Injectable({
  providedIn: 'root',
})
export class ThemeService {
  theme = signal<'light' | 'dark' | 'system'>('system');

  private isDarkMode = signal(false);

  constructor() {
    this.initializeTheme();
  }

  private initializeTheme(): void {
    const storedPreference = localStorage.getItem('theme') as 'light' | 'dark' | 'system' | null;

    if (storedPreference) {
      this.theme.set(storedPreference);
    }

    this.updateDarkMode();
    this.applyTheme();
  }

  private updateDarkMode(): void {
    const theme = this.theme();
    let shouldBeDark = false;

    if (theme === 'system') {
      shouldBeDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    } else {
      shouldBeDark = theme === 'dark';
    }

    this.isDarkMode.set(shouldBeDark);
  }

  private applyTheme(): void {
    const html = document.documentElement;

    if (this.isDarkMode()) {
      html.classList.add('dark');
    } else {
      html.classList.remove('dark');
    }

    html.setAttribute('data-theme', this.isDarkMode() ? 'dark' : 'light');
  }

  toggleTheme(): void {
    const current = this.theme();
    const themes: ('light' | 'dark' | 'system')[] = ['light', 'dark', 'system'];
    const currentIndex = themes.indexOf(current);
    const nextIndex = (currentIndex + 1) % themes.length;

    this.setTheme(themes[nextIndex]);
  }

  setTheme(theme: 'light' | 'dark' | 'system'): void {
    this.theme.set(theme);
    localStorage.setItem('theme', theme);
    this.updateDarkMode();
    this.applyTheme();
  }

  get isDark(): boolean {
    return this.isDarkMode();
  }
}
```

### 2.3 WebSocket Service

**Create `/home/cdom/saas/dimasite/src/app/core/services/websocket.service.ts`:**

```typescript
import { Injectable, inject } from '@angular/core';
import { io, Socket } from 'socket.io-client';
import { environment } from '../../../environments/environment';

@Injectable({
  providedIn: 'root'
})
export class WebsocketService {
  private sockets: Map<string, Socket> = new Map();
  private listeners: Map<string, Map<string, Function[]>> = new Map();

  constructor() {}

  private getSocketUrl(): string {
    return environment.production
      ? 'https://api.domdimabot.com'
      : 'http://localhost:3000';
  }

  connect(namespace: string): Socket {
    if (this.sockets.has(namespace)) {
      return this.sockets.get(namespace)!;
    }

    const socket = io(`${this.getSocketUrl()}${namespace}`, {
      transports: ['websocket', 'polling'],
      reconnection: true,
      reconnectionAttempts: 5,
      reconnectionDelay: 1000,
    });

    this.sockets.set(namespace, socket);
    return socket;
  }

  connectMultipleNamespaces(namespaces: string[]): Promise<void> {
    const connections = namespaces.map(ns => this.connect(ns));
    return Promise.all(connections).then(() => {
      console.log('All WebSocket namespaces connected:', namespaces);
    });
  }

  disconnect(namespace: string): void {
    const socket = this.sockets.get(namespace);
    if (socket) {
      socket.disconnect();
      this.sockets.delete(namespace);
      this.listeners.delete(namespace);
      console.log(`Disconnected from namespace: ${namespace}`);
    }
  }

  on(namespace: string, event: string, callback: Function): void {
    const socket = this.connect(namespace);

    socket.on(event, (data: any) => {
      callback(data);
    });

    // Store listener for cleanup
    if (!this.listeners.has(namespace)) {
      this.listeners.set(namespace, new Map());
    }
    const nsListeners = this.listeners.get(namespace)!;
    if (!nsListeners.has(event)) {
      nsListeners.set(event, []);
    }
    nsListeners.get(event)!.push(callback);
  }

  onNamespace(namespace: string, event: string, callback: Function): void {
    return this.on(namespace, event, callback);
  }

  emit(namespace: string, event: string, data?: any): void {
    const socket = this.sockets.get(namespace);
    if (socket && socket.connected) {
      socket.emit(event, data);
    } else {
      console.warn(`Socket ${namespace} not connected, cannot emit ${event}`);
    }
  }

  disconnectAll(): void {
    this.sockets.forEach((socket, namespace) => {
      socket.disconnect();
      console.log(`Disconnected from namespace: ${namespace}`);
    });
    this.sockets.clear();
    this.listeners.clear();
  }
}
```

### 2.4 Links Service

**Create `/home/cdom/saas/dimasite/src/app/core/services/links.service.ts`:**

```typescript
import { Injectable } from '@angular/core';
import { environment } from '../../../environments/environment';

@Injectable({
  providedIn: 'root'
})
export class LinksService {
  private twitchAuthUrl: string;

  constructor() {
    const baseUrl = this.getBaseUrl();
    const redirectUri = encodeURIComponent(`${baseUrl}/login`);

    this.twitchAuthUrl = `https://id.twitch.tv/oauth2/authorize?response_type=token&force_verify=false&client_id=${environment.CLIENT_ID}&redirect_uri=${redirectUri}&response_type=token`;
  }

  getTwitchAuthUrl(): string {
    return this.twitchAuthUrl;
  }

  getApiUrl(): string {
    return environment.production ? 'https://api.domdimabot.com' : 'http://localhost:3000';
  }

  getBaseUrl(): string {
    return environment.production ? 'https://domdimabot.com' : 'http://localhost:4200';
  }

  getDiscordUrl(): string {
    return environment.DISCORD_URL;
  }
}
```

### 2.5 Site Stats Model

**Create `/home/cdom/saas/dimasite/src/app/core/models/site-stats.model.ts`:**

```typescript
export interface SiteStats {
  activeChannels: number;
  liveChannels: number;
  registeredChannels: number;
}

export interface AnalyticsNamespace {
  name: string;
  eventName: string;
}
```

---

## Phase 3: Landing Page Component

### 3.1 Component TypeScript

**Create `/home/cdom/saas/dimasite/src/app/features/landing/landing-page.component.ts`:**

```typescript
import { Component, inject, ElementRef, HostListener, signal, computed, OnInit, OnDestroy } from '@angular/core';
import { Router } from '@angular/router';
import { LinksService } from '../../core/services/links.service';
import { LanguageService, SupportedLanguage } from '../../core/services/language.service';
import { ThemeService } from '../../core/services/theme.service';
import { WebsocketService } from '../../core/services/websocket.service';
import { SiteStats } from '../../core/models/site-stats.model';
import { LucideAngularModule } from 'lucide-angular';
import { CountUpDirective } from '../../shared/directives/count-up.directive';
import { TranslatePipe } from '@ngx-translate/core';
import {
  Activity,
  Tv,
  Users,
  MessageCircle,
  Zap,
  Settings,
  Check,
  Languages,
} from 'lucide-angular';
import { environment } from '../../../environments/environment';

@Component({
  selector: 'app-landing-page',
  standalone: true,
  imports: [LucideAngularModule, CountUpDirective, TranslatePipe],
  templateUrl: './landing-page.component.html',
  styleUrl: './landing-page.component.css',
  changeDetection: 0
})
export class LandingPageComponent implements OnInit, OnDestroy {
  private router = inject(Router);
  private linksService = inject(LinksService);
  private languageService = inject(LanguageService);
  private themeService = inject(ThemeService);
  private websocketService = inject(WebsocketService);
  private elementRef = inject(ElementRef<HTMLElement>);

  // Signals
  siteStats = signal<SiteStats>({
    activeChannels: 0,
    liveChannels: 0,
    registeredChannels: 0
  });

  currentLanguage = computed(() => this.languageService.getCurrentLanguage());
  currentTheme = computed(() => this.themeService.theme());

  // Icons
  activityIcon = Activity;
  tvIcon = Tv;
  usersIcon = Users;
  messageCircleIcon = MessageCircle;
  zapIcon = Zap;
  settingsIcon = Settings;
  checkIcon = Check;
  languageIcon = Languages;

  // State
  twitchAuthUrl = '';
  referral = '';

  // WebSocket namespaces for analytics
  private analyticsNamespaces = [
    '/site/analytics/active-channels',
    '/site/analytics/live-channels',
    '/site/analytics/registered-channels'
  ];

  constructor() {
    this.twitchAuthUrl = this.linksService.getTwitchAuthUrl();
  }

  ngOnInit(): void {
    this.connectAnalyticsNamespaces();
    this.setupAnalyticsListeners();
    this.handleReferral();
    this.setupScrollAnimations();
    this.setupParallaxEffect();
  }

  ngOnDestroy(): void {
    this.disconnectAnalyticsNamespaces();
  }

  private connectAnalyticsNamespaces(): void {
    try {
      this.websocketService.connectMultipleNamespaces(this.analyticsNamespaces);
      console.log('WebSocket namespace connections established for analytics');
    } catch (error) {
      console.error('Failed to connect to WebSocket:', error);
    }
  }

  private setupAnalyticsListeners(): void {
    // Active channels
    this.websocketService.onNamespace('/site/analytics/active-channels', 'active-channels', (data: any) => {
      const value = parseInt(data);
      if (typeof value === 'number') {
        this.siteStats.update(stats => ({ ...stats, activeChannels: value }));
      }
    });

    // Live channels
    this.websocketService.onNamespace('/site/analytics/live-channels', 'live-channels', (data: any) => {
      const value = parseInt(data);
      if (typeof value === 'number') {
        this.siteStats.update(stats => ({ ...stats, liveChannels: value }));
      }
    });

    // Registered channels
    this.websocketService.onNamespace('/site/analytics/registered-channels', 'registered-channels', (data: any) => {
      const value = parseInt(data);
      if (typeof value === 'number') {
        this.siteStats.update(stats => ({ ...stats, registeredChannels: value }));
      }
    });
  }

  private disconnectAnalyticsNamespaces(): void {
    this.analyticsNamespaces.forEach(ns => {
      this.websocketService.disconnect(ns);
    });
  }

  private handleReferral(): void {
    const urlSegments = this.router.url.split('/');
    this.referral = urlSegments[1] || '';
  }

  private setupScrollAnimations(): void {
    if (typeof window === 'undefined' || typeof IntersectionObserver === 'undefined') {
      return;
    }

    const observer = new IntersectionObserver((entries) => {
      entries.forEach(entry => {
        if (entry.isIntersecting) {
          entry.target.classList.add('reveal-in');
          entry.target.classList.remove('reveal-init');
          observer.unobserve(entry.target);
        }
      });
    }, { threshold: 0.15 });

    setTimeout(() => {
      const elements = this.elementRef.nativeElement.querySelectorAll('.reveal-init');
      elements.forEach((el) => {
        observer.observe(el as Element);
      });
    }, 100);
  }

  private setupParallaxEffect(): void {
    if (typeof window === 'undefined') {
      return;
    }

    const onScroll = () => {
      const scrollY = window.scrollY || window.pageYOffset;

      // Toggle scrolled class on navbar
      const navbar = this.elementRef.nativeElement.querySelector('.sticky-navbar');
      if (navbar) {
        if (scrollY > 10) {
          navbar.classList.add('scrolled');
        } else {
          navbar.classList.remove('scrolled');
        }
      }

      // Parallax effect for aurora blobs
      const parallaxContainers = this.elementRef.nativeElement.querySelectorAll<HTMLElement>('.parallax-layer');
      parallaxContainers.forEach(layer => {
        const depthAttr = layer.getAttribute('data-depth');
        const depth = depthAttr ? parseFloat(depthAttr) : 0.05;
        const translateY = Math.round(scrollY * depth);
        layer.style.transform = `translate3d(0, ${translateY}px, 0)`;
      });
    };

    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
  }

  // User actions
  loginWithTwitch(): void {
    window.location.href = this.twitchAuthUrl;
  }

  openDiscord(): void {
    window.open(environment.DISCORD_URL, '_blank', 'noopener,noreferrer');
  }

  getCurrentLanguageInfo() {
    return this.languageService.getLanguageInfo(this.currentLanguage());
  }

  getAvailableLanguages() {
    return this.languageService.getAvailableLanguages();
  }

  toggleLanguage(): void {
    this.languageService.toggleLanguage();
  }

  switchLanguage(language: SupportedLanguage): void {
    this.languageService.setLanguage(language);
  }

  @HostListener('document:click', ['$event'])
  onDocumentClick(event: MouseEvent): void {
    const target = event.target as HTMLElement | null;
    if (!target) {
      return;
    }

    const clickInside = this.elementRef.nativeElement.contains(target);

    if (!clickInside) {
      // Handle click outside if needed (e.g., mobile menu)
    }
  }
}
```

### 3.2 Component HTML

**Create `/home/cdom/saas/dimasite/src/app/features/landing/landing-page.component.html`:**

```html
<div class="flex flex-col bg-gradient-to-b from-purple-50 via-purple-100 to-purple-200 dark:from-zinc-900 dark:via-zinc-800 dark:to-zinc-900 relative overflow-hidden">
  <!-- Aurora blobs with parallax -->
  <div class="parallax-layer" data-depth="0.03">
    <div class="aurora-blob blob-1"></div>
  </div>
  <div class="parallax-layer" data-depth="0.06">
    <div class="aurora-blob blob-2"></div>
  </div>
  <div class="parallax-layer" data-depth="0.09">
    <div class="aurora-blob blob-3"></div>
  </div>

  <!-- Sticky navbar -->
  <header class="sticky-navbar px-4 lg:px-6 h-14 flex items-center">
    <a class="flex items-center justify-center" href="#">
      <svg class="w-6 h-6 mr-2" role="img" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
        <title>Twitch</title>
        <path fill="#9146FF" d="M11.571 4.714h1.715v5.143H11.57zm4.715 0H18v5.143h-1.714zM6 0L1.714 4.286v15.428h5.143V24l4.286-4.286h3.428L22.286 12V0zm14.571 11.143l-3.428 3.428h-3.429l-3 3v-3H6.857V1.714h13.714Z"/>
      </svg>
      <span class="ml-2 text-2xl font-bold text-purple-900 dark:text-purple-100">
        DomDimaBot
      </span>
    </a>
    <nav class="ml-auto flex gap-4 sm:gap-6 items-center">
      <!-- Language toggle -->
      <button
        (click)="toggleLanguage()"
        class="nav-pill text-sm font-medium text-purple-900 dark:text-purple-100 flex items-center gap-1"
        title="Switch Language"
      >
        <lucide-icon [name]="languageIcon" class="w-4 h-4"></lucide-icon>
        <span class="text-sm">{{ getCurrentLanguageInfo().nativeName || 'English' }}</span>
      </button>
    </nav>
  </header>

  <!-- Spacer for fixed header -->
  <div class="h-14"></div>

  <!-- Main content -->
  <main class="flex-1">
    <!-- Hero section -->
    <section class="w-full py-12 md:py-24 lg:py-32 xl:py-48 reveal-init">
      <div class="container mx-auto px-4 md:px-6">
        <div class="flex flex-col items-center space-y-4 text-center">
          <div class="space-y-2">
            <h1 class="gradient-text text-3xl font-bold tracking-tighter sm:text-4xl md:text-5xl lg:text-6xl/none">
              {{ 'landing.hero.title' | translate }}
            </h1>
            <p class="mx-auto max-w-[700px] text-purple-800 dark:text-purple-200 md:text-xl">
              {{ 'landing.hero.description' | translate }}
            </p>
          </div>
          <div class="flex flex-col sm:flex-row gap-4 justify-center items-center">
            <button
              class="btn-gradient hover:cursor-pointer"
              (click)="loginWithTwitch()"
            >
              <svg class="w-6 h-6" role="img" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
                <title>Twitch</title>
                <path fill="#9146FF" d="M11.571 4.714h1.715v5.143H11.57zm4.715 0H18v5.143h-1.714zM6 0L1.714 4.286v15.428h5.143V24l4.286-4.286h3.428L22.286 12V0zm14.571 11.143l-3.428 3.428h-3.429l-3 3v-3H6.857V1.714h13.714Z"/>
              </svg>
              <span>{{ 'landing.hero.loginWith' | translate }}</span>
            </button>
            <button
              class="btn-outline-gradient hover:cursor-pointer"
              (click)="openDiscord()"
            >
              <p class="inline">
                {{ 'landing.hero.join' | translate }}
              </p>
            </button>
          </div>
        </div>
      </div>
    </section>

    <!-- Analytics section -->
    <section class="w-full py-12 bg-purple-200/60 dark:bg-zinc-800/60 backdrop-blur reveal-init">
      <div class="container mx-auto px-4 md:px-6">
        <h2 class="text-3xl font-bold tracking-tighter sm:text-4xl md:text-5xl text-center mb-12 text-purple-900 dark:text-purple-100">
          {{ 'landing.analytics.title' | translate }}
        </h2>
        <div class="grid gap-8 sm:grid-cols-3">
          <div class="glass-card card-hover flex flex-col items-center space-y-2 border-purple-300 dark:border-purple-700 p-4 rounded-lg">
            <lucide-icon [name]="activityIcon" class="h-8 w-8 text-purple-600 dark:text-purple-400 glow-icon"></lucide-icon>
            <h3 class="text-xl font-bold text-purple-900 dark:text-purple-100">
              {{ 'landing.analytics.activeChannels' | translate }}
            </h3>
            <p class="text-3xl font-bold text-purple-600 dark:text-purple-400" [countUp]="siteStats().activeChannels">
              0
            </p>
          </div>
          <div class="glass-card card-hover flex flex-col items-center space-y-2 border-purple-300 dark:border-purple-700 p-4 rounded-lg">
            <lucide-icon [name]="tvIcon" class="h-8 w-8 text-purple-600 dark:text-purple-400 glow-icon"></lucide-icon>
            <h3 class="text-xl font-bold text-purple-900 dark:text-purple-100">
              {{ 'landing.analytics.liveChannels' | translate }}
            </h3>
            <p class="text-3xl font-bold text-purple-600 dark:text-purple-400" [countUp]="siteStats().liveChannels">
              0
            </p>
          </div>
          <div class="glass-card card-hover flex flex-col items-center space-y-2 border-purple-300 dark:border-purple-700 p-4 rounded-lg">
            <lucide-icon [name]="usersIcon" class="h-8 w-8 text-purple-600 dark:text-purple-400 glow-icon"></lucide-icon>
            <h3 class="text-xl font-bold text-purple-900 dark:text-purple-100">
              {{ 'landing.analytics.registeredChannels' | translate }}
            </h3>
            <p class="text-3xl font-bold text-purple-600 dark:text-purple-400" [countUp]="siteStats().registeredChannels">
              0
            </p>
          </div>
        </div>
      </div>
    </section>

    <!-- Features section -->
    <section id="features" class="w-full py-12 md:py-24 lg:py-32 reveal-init">
      <div class="container mx-auto px-4 md:px-6">
        <h2 class="text-3xl font-bold tracking-tighter sm:text-4xl md:text-5xl text-center mb-12 text-purple-900 dark:text-purple-100">
          {{ 'landing.features.title' | translate }}
        </h2>
        <div class="grid gap-10 sm:grid-cols-2 md:grid-cols-3">
          <div class="glass-card card-hover flex flex-col items-center space-y-3 text-center p-6 rounded-lg">
            <lucide-icon [name]="messageCircleIcon" class="h-12 w-12 text-purple-600 dark:text-purple-400 glow-icon"></lucide-icon>
            <h3 class="text-xl font-bold text-purple-900 dark:text-purple-100">
              {{ 'landing.features.smartChatModeration' | translate }}
            </h3>
            <p class="text-purple-800 dark:text-purple-200">
              {{ 'landing.features.smartChatModerationDescription' | translate }}
            </p>
          </div>
          <div class="glass-card card-hover flex flex-col items-center space-y-3 text-center p-6 rounded-lg">
            <lucide-icon [name]="zapIcon" class="h-12 w-12 text-purple-600 dark:text-purple-400 glow-icon"></lucide-icon>
            <h3 class="text-xl font-bold text-purple-900 dark:text-purple-100">
              {{ 'landing.features.customCommands' | translate }}
            </h3>
            <p class="text-purple-800 dark:text-purple-200">
              {{ 'landing.features.customCommandsDescription' | translate }}
            </p>
          </div>
          <div class="glass-card card-hover flex flex-col items-center space-y-3 text-center p-6 rounded-lg">
            <lucide-icon [name]="settingsIcon" class="h-12 w-12 text-purple-600 dark:text-purple-400 glow-icon"></lucide-icon>
            <h3 class="text-xl font-bold text-purple-900 dark:text-purple-100">
              {{ 'landing.features.easyIntegration' | translate }}
            </h3>
            <p class="text-purple-800 dark:text-purple-200">
              {{ 'landing.features.easyIntegrationDescription' | translate }}
            </p>
          </div>
        </div>
      </div>
    </section>

    <!-- Pricing section -->
    <section id="pricing" class="w-full py-12 md:py-24 lg:py-32 bg-purple-200/60 dark:bg-zinc-800/60 backdrop-blur reveal-init">
      <div class="container mx-auto px-4 md:px-6">
        <h2 class="text-3xl font-bold tracking-tighter sm:text-4xl md:text-5xl text-center mb-12 text-purple-900 dark:text-purple-100">
          {{ 'landing.pricing.title' | translate }}
        </h2>
        <h3 class="text-2xl font-bold tracking-tighter sm:text-3xl md:text-4xl text-center mb-2 text-purple-900 dark:text-purple-100">
          {{ 'landing.pricing.monthly' | translate }}
        </h3>
        <div class="grid gap-6 lg:grid-cols-3">
          <!-- Basic plan -->
          <div class="glass-card card-hover flex flex-col p-6 rounded-lg">
            <h3 class="text-2xl font-bold text-purple-900 dark:text-purple-100">
              {{ 'landing.pricing.basic.title' | translate }}
            </h3>
            <div class="mt-4 text-purple-900 dark:text-purple-100 text-4xl font-bold">$0.00 USD</div>
            <p class="mt-2 text-purple-700 dark:text-purple-300">
              {{ 'landing.pricing.basic.description' | translate }}
            </p>
            <ul class="mt-4 space-y-2">
              <li class="flex items-center">
                <lucide-icon [name]="checkIcon" class="mr-2 h-5 w-5"></lucide-icon>
                <span class="text-purple-800 dark:text-purple-200">
                  {{ 'landing.pricing.basic.features.smartChatModeration' | translate }}
                </span>
              </li>
              <li class="flex items-center">
                <lucide-icon [name]="checkIcon" class="mr-2 h-5 w-5"></lucide-icon>
                <span class="text-purple-800 dark:text-purple-200">
                  {{ 'landing.pricing.basic.features.unlimitedSimpleCustomCommands' | translate }}
                </span>
              </li>
              <li class="flex items-center">
                <lucide-icon [name]="checkIcon" class="mr-2 h-5 w-5"></lucide-icon>
                <span class="text-purple-800 dark:text-purple-200">
                  {{ 'landing.pricing.basic.features.basicAnalytics' | translate }}
                </span>
              </li>
            </ul>
            <button
              class="mt-6 btn-gradient hover:cursor-pointer"
              (click)="loginWithTwitch()"
            >
              {{ 'landing.pricing.choosePlan' | translate }}
            </button>
          </div>

          <!-- Premium plan -->
          <div class="glass-card card-hover flex flex-col p-6 rounded-lg">
            <h3 class="text-2xl font-bold text-purple-900 dark:text-purple-100">
              {{ 'landing.pricing.premium.title' | translate }}
            </h3>
            <div class="mt-4 text-purple-900 dark:text-purple-100 text-4xl font-bold">$5 USD</div>
            <p class="mt-2 text-purple-700 dark:text-purple-300">
              {{ 'landing.pricing.premium.description' | translate }}
            </p>
            <button
              class="mt-6 btn-gradient hover:cursor-pointer disabled:bg-slate-700 disabled:cursor-not-allowed opacity-50"
              (click)="loginWithTwitch()"
              disabled
            >
              {{ 'landing.pricing.choosePlan' | translate }}
            </button>
          </div>

          <!-- AI plan -->
          <div class="glass-card card-hover flex flex-col p-6 rounded-lg">
            <h3 class="text-2xl font-bold text-purple-900 dark:text-purple-100">AI</h3>
            <div class="mt-4 text-purple-900 dark:text-purple-100 text-4xl font-bold">$N/A</div>
            <p class="mt-2 text-purple-700 dark:text-purple-300">
              {{ 'landing.pricing.ai.description' | translate }}
            </p>
            <button
              class="mt-6 btn-gradient hover:cursor-pointer disabled:bg-slate-700 disabled:cursor-not-allowed opacity-50"
              (click)="loginWithTwitch()"
              disabled
            >
              {{ 'landing.pricing.choosePlan' | translate }}
            </button>
          </div>
        </div>
      </div>
    </section>

    <!-- CTA section -->
    <section id="cta" class="w-full py-12 md:py-24 lg:py-32 reveal-init">
      <div class="container mx-auto px-4 md:px-6">
        <div class="flex flex-col items-center space-y-4 text-center">
          <div class="space-y-2">
            <h2 class="text-3xl font-bold tracking-tighter sm:text-4xl md:text-5xl text-purple-900 dark:text-purple-100">
              {{ 'landing.callToAction.title' | translate }}
            </h2>
            <p class="mx-auto max-w-[600px] text-purple-800 dark:text-purple-200 md:text-xl">
              {{ 'landing.callToAction.description' | translate }}
            </p>
          </div>
          <div class="w-full max-w-sm space-y-2">
            <button
              class="w-full btn-gradient text-white font-semibold py-2 px-4 rounded-md flex items-center justify-center space-x-2"
              (click)="loginWithTwitch()"
            >
              <svg class="w-6 h-6" role="img" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
                <title>Twitch</title>
                <path fill="#9146FF" d="M11.571 4.714h1.715v5.143H11.57zm4.715 0H18v5.143h-1.714zM6 0L1.714 4.286v15.428h5.143V24l4.286-4.286h3.428L22.286 12V0zm14.571 11.143l-3.428 3.428h-3.429l-3 3v-3H6.857V1.714h13.714Z"/>
              </svg>
              <span>{{ 'landing.callToAction.button' | translate }}</span>
            </button>
            <p class="text-xs text-purple-700 dark:text-purple-300">
              {{ 'landing.callToAction.terms' | translate }}
            </p>
          </div>
        </div>
      </div>
    </section>
  </main>

  <!-- Footer -->
  <footer class="flex flex-col gap-2 sm:flex-row py-6 w-full shrink-0 items-center px-4 md:px-6 border-t border-purple-200 dark:border-purple-700">
    <p class="text-xs text-purple-700 dark:text-purple-300">
      {{ 'landing.footer.copyright' | translate }}
    </p>
    <nav class="sm:ml-auto flex gap-4 sm:gap-6 items-center">
      <a class="text-xs hover:underline underline-offset-4 text-purple-700 dark:text-purple-300" href="#">
        {{ 'landing.footer.terms' | translate }}
      </a>
      <a class="text-xs hover:underline underline-offset-4 text-purple-700 dark:text-purple-300" href="#">
        {{ 'landing.footer.privacy' | translate }}
      </a>
      <button
        (click)="toggleLanguage()"
        class="text-xs hover:underline underline-offset-4 text-purple-700 dark:text-purple-300 flex items-center gap-1"
        title="Switch Language"
      >
        <lucide-icon [name]="languageIcon" class="w-3 h-3"></lucide-icon>
        <span>{{ getCurrentLanguageInfo().nativeName || 'English' }}</span>
      </button>
    </nav>
  </footer>
</div>
```

### 3.3 Component CSS

**Create `/home/cdom/saas/dimasite/src/app/features/landing/landing-page.component.css`:**

```css
:host {
  display: block;
}

/* Additional component-specific styles can go here if needed */
/* Most styles are handled in global styles.css */
```

---

## Phase 4: Shared Directives

### 4.1 Count-Up Directive

**Create `/home/cdom/saas/dimasite/src/app/shared/directives/count-up.directive.ts`:**

```typescript
import { Directive, ElementRef, Input, OnInit, OnDestroy, OnChanges, SimpleChanges } from '@angular/core';

@Directive({
  selector: '[countUp]',
  standalone: true
})
export class CountUpDirective implements OnInit, OnDestroy, OnChanges {
  @Input() countUp!: number;
  @Input() duration: number = 2000;
  @Input() startValue: number = 0;

  private observer!: IntersectionObserver;
  private hasAnimated: boolean = false;
  private currentDisplayedValue: number = 0;
  private animationFrameId: number | null = null;
  private isAnimating: boolean = false;
  private pendingValue: number | null = null;
  private updateTimeout: number | null = null;

  constructor(private el: ElementRef) {}

  ngOnInit() {
    this.currentDisplayedValue = this.startValue;
    this.el.nativeElement.textContent = this.formatNumber(this.startValue);

    this.observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting && !this.hasAnimated) {
            this.animateCount();
            this.hasAnimated = true;
            this.observer.unobserve(this.el.nativeElement);
          }
        });
      },
      { threshold: 0.1 }
    );

    this.observer.observe(this.el.nativeElement);
  }

  ngOnDestroy() {
    if (this.observer) {
      this.observer.disconnect();
    }
    if (this.animationFrameId) {
      cancelAnimationFrame(this.animationFrameId);
    }
    if (this.updateTimeout) {
      clearTimeout(this.updateTimeout);
    }
  }

  ngOnChanges(changes: SimpleChanges): void {
    if (changes['countUp'] && !changes['countUp'].firstChange) {
      const newValue = changes['countUp'].currentValue;

      if (this.hasAnimated) {
        this.handleValueUpdate(newValue);
      }
    }
  }

  private animateCount() {
    const startTime = performance.now();
    const startValue = this.hasAnimated ? this.currentDisplayedValue : this.startValue;
    const endValue = this.countUp;
    const duration = this.duration;

    this.el.nativeElement.classList.add('counting', 'stats-number');
    this.isAnimating = true;

    const animate = (currentTime: number) => {
      const elapsed = currentTime - startTime;
      const progress = Math.min(elapsed / duration, 1);
      const easeOutQuart = 1 - Math.pow(1 - progress, 4);
      const currentValue = Math.floor(startValue + (endValue - startValue) * easeOutQuart);

      this.el.nativeElement.textContent = this.formatNumber(currentValue);

      if (progress < 1) {
        this.animationFrameId = requestAnimationFrame(animate);
      } else {
        this.el.nativeElement.textContent = this.formatNumber(endValue);
        this.currentDisplayedValue = endValue;
        this.el.nativeElement.classList.remove('counting');
        this.isAnimating = false;
        this.animationFrameId = null;
      }
    };

    this.animationFrameId = requestAnimationFrame(animate);
  }

  private handleValueUpdate(newValue: number): void {
    this.pendingValue = newValue;

    if (this.updateTimeout) {
      clearTimeout(this.updateTimeout);
    }

    this.updateTimeout = window.setTimeout(() => {
      if (this.pendingValue !== null) {
        this.updateToNewValue(this.pendingValue);
        this.pendingValue = null;
      }
    }, 100);
  }

  private updateToNewValue(newValue: number): void {
    if (this.isAnimating && this.animationFrameId) {
      cancelAnimationFrame(this.animationFrameId);
      this.isAnimating = false;
      this.animationFrameId = null;
    }

    const currentText = this.el.nativeElement.textContent;
    const currentDisplayed = this.parseDisplayedValue(currentText);
    const startTime = performance.now();
    const startValue = currentDisplayed;
    const endValue = newValue;
    const duration = this.duration;

    this.el.nativeElement.classList.add('counting');
    this.isAnimating = true;

    const animate = (currentTime: number) => {
      const elapsed = currentTime - startTime;
      const progress = Math.min(elapsed / duration, 1);
      const easeOutQuart = 1 - Math.pow(1 - progress, 4);
      const currentValue = Math.floor(startValue + (endValue - startValue) * easeOutQuart);

      this.el.nativeElement.textContent = this.formatNumber(currentValue);

      if (progress < 1) {
        this.animationFrameId = requestAnimationFrame(animate);
      } else {
        this.el.nativeElement.textContent = this.formatNumber(endValue);
        this.currentDisplayedValue = endValue;
        this.el.nativeElement.classList.remove('counting');
        this.isAnimating = false;
        this.animationFrameId = null;
      }
    };

    this.animationFrameId = requestAnimationFrame(animate);
  }

  private parseDisplayedValue(text: string): number {
    const cleaned = text.replace(/,/g, '');
    const parsed = parseInt(cleaned, 10);
    return isNaN(parsed) ? this.currentDisplayedValue : parsed;
  }

  private formatNumber(num: number): string {
    return num.toLocaleString();
  }
}
```

---

## Phase 5: Translation Files

### 5.1 English Translation

**Create `/home/cdom/saas/dimasite/src/assets/i18n/en.json`:**

Copy the `landing` section from `/home/cdom/saas/dima-site/src/assets/i18n/en.json` (lines 373-446).

### 5.2 Spanish Translation

**Create `/home/cdom/saas/dimasite/src/assets/i18n/es.json`:**

Copy the `landing` section from `/home/cdom/saas/dima-site/src/assets/i18n/es.json` (lines 373-446).

---

## Phase 6: App Configuration

### 6.1 App Config

**Update `/home/cdom/saas/dimasite/src/app/app.config.ts`:**

```typescript
import { ApplicationConfig, provideHttpClient } from '@angular/core';
import { provideRouter } from '@angular/router';
import { TranslateModule, TranslateLoader } from '@ngx-translate/core';
import { HttpClient } from '@angular/common/http';
import { TranslateHttpLoader } from '@ngx-translate/http-loader';
import { routes } from './app.routes';
import { LanguageService, HttpLoaderFactory } from './core/services/language.service';

export function HttpLoaderFactory(http: HttpClient) {
  return new TranslateHttpLoader(http, './assets/i18n/', '.json');
}

export const appConfig: ApplicationConfig = {
  providers: [
    provideRouter(routes),
    provideHttpClient(),
    TranslateModule.forRoot({
      loader: {
        provide: TranslateLoader,
        useFactory: HttpLoaderFactory,
        deps: [HttpClient]
      },
      defaultLanguage: 'en'
    }).providers!
  ]
};
```

### 6.2 Routes

**Update `/home/cdom/saas/dimasite/src/app/app.routes.ts`:**

```typescript
import { Routes } from '@angular/router';

export const routes: Routes = [
  // Landing page (eager-loaded)
  { path: '', loadComponent: () => import('./features/landing/landing-page.component').then(m => m.LandingPageComponent) },
  { path: ':streamer', loadComponent: () => import('./features/landing/landing-page.component').then(m => m.LandingPageComponent) },

  { path: '**', redirectTo: '' }
];
```

### 6.3 App Component

**Update `/home/cdom/saas/dimasite/src/app/app.ts`:**

```typescript
import { Component, signal, inject, OnInit } from '@angular/core';
import { RouterOutlet } from '@angular/router';
import { ThemeService } from './core/services/theme.service';
import { LanguageService } from './core/services/language.service';
import { CommonModule } from '@angular/common';

@Component({
  selector: 'app-root',
  imports: [CommonModule, RouterOutlet],
  templateUrl: './app.html',
  styleUrl: './app.css',
  changeDetection: 0
})
export class App implements OnInit {
  private themeService = inject(ThemeService);
  private languageService = inject(LanguageService);

  protected readonly title = signal('DomDimaBot');

  ngOnInit(): void {
    // Theme and language are initialized by their services
    console.log('App initialized with theme:', this.themeService.theme());
    console.log('App initialized with language:', this.languageService.getCurrentLanguage());
  }
}
```

### 6.4 App HTML

**Update `/home/cdom/saas/dimasite/src/app/app.html`:**

```html
<router-outlet></router-outlet>
```

### 6.5 App CSS

**Update `/home/cdom/saas/dimasite/src/app/app.css`:**

```css
:host {
  display: block;
}
```

### 6.6 Main

**Update `/home/cdom/saas/dimasite/src/main.ts`:**

```typescript
import { bootstrapApplication } from '@angular/platform-browser';
import { appConfig } from './app/app.config';
import { App } from './app/app';

bootstrapApplication(App, appConfig)
  .catch((err) => console.error(err));
```

---

## Phase 7: Assets

### 7.1 Favicon

**Copy favicon from reference:**

```bash
cp /home/cdom/saas/dima-site/public/favicon.ico /home/cdom/saas/dimasite/public/favicon.ico
```

### 7.2 Directory Structure

**Create asset directories:**

```bash
mkdir -p /home/cdom/saas/dimasite/src/assets/i18n
mkdir -p /home/cdom/saas/dimasite/src/assets/images
```

---

## Phase 8: Optional Three.js Integration

### 8.1 Setup (Optional Enhancement)

**If you want to add Three.js to the landing page, follow these steps:**

1. **Update landing-page.component.ts** to include Three.js imports:
```typescript
import * as THREE from 'three';
```

2. **Add Three.js fields to component:**
```typescript
private scene!: THREE.Scene;
private camera!: THREE.PerspectiveCamera;
private renderer!: THREE.WebGLRenderer;
private particles!: THREE.Points;
private animationId!: number;
private canvasContainer!: HTMLElement;
```

3. **Add `ngAfterViewInit` method:**
```typescript
ngAfterViewInit(): void {
  super.ngOnInit();
  this.initThreeJS();
  this.createParticles();
  this.animate();
}

private initThreeJS(): void {
  this.canvasContainer = this.elementRef.nativeElement.querySelector('#three-container')!;
  if (!this.canvasContainer) return;

  this.scene = new THREE.Scene();
  this.camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 1000);
  this.renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true });
  this.renderer.setSize(window.innerWidth, window.innerHeight);
  this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  this.canvasContainer.appendChild(this.renderer.domElement);
}

private createParticles(): void {
  const geometry = new THREE.BufferGeometry();
  const count = 500;
  const positions = new Float32Array(count * 3);

  for (let i = 0; i < count * 3; i++) {
    positions[i] = (Math.random() - 0.5) * 10;
  }

  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));

  const material = new THREE.PointsMaterial({
    size: 0.05,
    color: 0x8b5cf6,
    transparent: true,
    opacity: 0.6
  });

  this.particles = new THREE.Points(geometry, material);
  this.scene.add(this.particles);
  this.camera.position.z = 5;
}

private animate(): void {
  this.animationId = requestAnimationFrame(this.animate.bind(this));
  this.particles.rotation.x += 0.001;
  this.particles.rotation.y += 0.001;
  this.renderer.render(this.scene, this.camera);
}
```

4. **Update ngOnDestroy to clean up:**
```typescript
ngOnDestroy(): void {
  super.ngOnDestroy();
  if (this.animationId) {
    cancelAnimationFrame(this.animationId);
  }
  if (this.renderer) {
    this.renderer.dispose();
  }
}
```

5. **Add container to HTML:**
```html
<div id="three-container" class="absolute inset-0 pointer-events-none z-0"></div>
```

**Note:** This is optional. The landing page works perfectly without Three.js. Add it only if you want the extra visual enhancement.

---

## Implementation Order

Follow this exact order for implementation:

1. **Setup Configuration**
   - Install packages (@ngx-translate packages)
   - Create tailwind.config.js
   - Create environment files
   - Update index.html

2. **Create Global Styles**
   - Update styles.css with all animations and utility classes

3. **Create Core Services**
   - language.service.ts
   - theme.service.ts
   - websocket.service.ts
   - links.service.ts
   - site-stats.model.ts

4. **Create Translation Files**
   - en.json (landing section)
   - es.json (landing section)

5. **Create Shared Directive**
   - count-up.directive.ts

6. **Create Landing Page Component**
   - landing-page.component.ts
   - landing-page.component.html
   - landing-page.component.css

7. **Configure App**
   - Update app.config.ts
   - Update app.routes.ts
   - Update app.ts
   - Update app.html
   - Update app.css
   - Update main.ts

8. **Copy Assets**
   - favicon.ico

9. **Test & Verify**
   - Run `npm start`
   - Check landing page loads
   - Verify translations work (EN/ES)
   - Verify theme toggle
   - Verify analytics WebSocket
   - Verify count-up animations
   - Test on mobile

10. **Optional Three.js** (if desired)
    - Add Three.js to landing page

---

## Testing Checklist

Before moving to the next phase, verify:

✅ Landing page loads at root URL (`/`)
✅ Landing page loads at streamer URL (`/:streamer`)
✅ Dark/light mode toggle works
✅ Language toggle works (EN/ES)
✅ All translations display correctly
✅ WebSocket analytics receive live data
✅ Count-up animations trigger on scroll
✅ Scroll reveal animations work
✅ Parallax aurora blobs animate on scroll
✅ Glassmorphism cards have correct styling
✅ Gradient text animates
✅ Buttons have hover effects
✅ Mobile responsive design works (375px, 414px, 768px)
✅ Tablet responsive design works (1024px)
✅ Desktop responsive design works (1280px, 1920px)
✅ No console errors
✅ Performance is good (no layout thrashing)

---

## Next Steps After Landing Page

Once the landing page is complete and tested, the next implementation plan should cover:

1. **Login Page** - Handle Twitch OAuth callback
2. **Logout Page** - Clear session
3. **Authenticated Layout** - Navbar, sidebar, theme/language toggles
4. **Dashboard** - ECharts integration, live analytics

Each subsequent page will have its own detailed plan file.

---

## Notes for Builder AI

1. **Reference dima-site implementation** for business logic
2. **Use Angular v21 patterns** - signals, standalone components, inject()
3. **Maintain API compatibility** - don't change backend contracts
4. **Follow purple design system** - colors, animations, glassmorphism
5. **Ensure accessibility** - WCAG AA, semantic HTML, ARIA labels
6. **Test thoroughly** - verify all features before moving to next phase
7. **Be creative** - suggest improvements but keep core functionality intact
8. **Ask questions** - if something is unclear, ask for clarification

---

## Files to Create (Summary)

**Configuration:**
- `/home/cdom/saas/dimasite/tailwind.config.js`
- `/home/cdom/saas/dimasite/src/environments/environment.ts`
- `/home/cdom/saas/dimasite/src/environments/environment.development.ts`
- `/home/cdom/saas/dimasite/src/index.html`

**Styles:**
- `/home/cdom/saas/dimasite/src/styles.css` (update)

**Core Services:**
- `/home/cdom/saas/dimasite/src/app/core/services/language.service.ts`
- `/home/cdom/saas/dimasite/src/app/core/services/theme.service.ts`
- `/home/cdom/saas/dimasite/src/app/core/services/websocket.service.ts`
- `/home/cdom/saas/dimasite/src/app/core/services/links.service.ts`
- `/home/cdom/saas/dimasite/src/app/core/models/site-stats.model.ts`

**Shared Directives:**
- `/home/cdom/saas/dimasite/src/app/shared/directives/count-up.directive.ts`

**Landing Page:**
- `/home/cdom/saas/dimasite/src/app/features/landing/landing-page.component.ts`
- `/home/cdom/saas/dimasite/src/app/features/landing/landing-page.component.html`
- `/home/cdom/saas/dimasite/src/app/features/landing/landing-page.component.css`

**Translations:**
- `/home/cdom/saas/dimasite/src/assets/i18n/en.json`
- `/home/cdom/saas/dimasite/src/assets/i18n/es.json`

**App Config:**
- `/home/cdom/saas/dimasite/src/app/app.config.ts` (update)
- `/home/cdom/saas/dimasite/src/app/app.routes.ts` (update)
- `/home/cdom/saas/dimasite/src/app/app.ts` (update)
- `/home/cdom/saas/dimasite/src/app/app.html` (update)
- `/home/cdom/saas/dimasite/src/app/app.css` (update)
- `/home/cdom/saas/dimasite/src/main.ts` (update)

**Assets:**
- `/home/cdom/saas/dimasite/public/favicon.ico`

**Total: 19 files to create/update**

---

Good luck with the implementation! 🚀
