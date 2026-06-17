# Authenticated Navbar Redesign Plan

## Overview
Redesign the authenticated navbar with a modern, beautiful layout featuring:
- **Left**: Logo/brand (DomDimaBot)
- **Middle**: Dashboard | Commands | Modules | Settings | Admin Hub
- **Right**: Profile avatar → dropdown with Display Name + Plan Tier Badge | Profile Settings | Theme/Language toggles | Logout

## Files to Modify/Create

### 1. Component Logic
**File**: `dimasite/src/app/features/layout/authenticated-layout.component.ts`

Changes:
- Inject `SessionAuthService` to access `session` signal
- Add computed signals:
  - `userName()` - from `session()?.twitchUser.display_name` or `login`
  - `userAvatar()` - from `session()?.twitchUser.profile_image_url`
  - `planTier()` - from `session()?.appUser.plan_tier`
  - `planTierLabel()` - returns translated tier name (Free/Premium/Pro)
  - `languageLabel()` - returns 'EN' or 'ES' based on current language
- Add signals for dropdown:
  - `isDropdownOpen = signal(false)`
- Add methods:
  - `toggleDropdown()` - toggles dropdown open/closed
  - `closeDropdown()` - closes dropdown
  - `onProfileSettingsClick()` - navigates to `/${streamer()}/profile`

### 2. Navbar Template
**File**: `dimasite/src/app/features/layout/authenticated-layout.component.html`

Replace entire navbar section with:

```html
<header class="auth-navbar">
  <!-- Brand (left) -->
  <a class="auth-navbar__brand" routerLink="/">
    <span class="brand-dot" aria-hidden="true"></span>
    <span>DomDimaBot</span>
  </a>

  <!-- Navigation (center) -->
  <nav class="auth-navbar__nav" aria-label="Primary">
    <a
      class="auth-navbar__link"
      [routerLink]="['/', streamer(), 'dashboard']"
      routerLinkActive
      #dashboardLink="routerLinkActive"
      [class.auth-navbar__link--active]="dashboardLink.isActive"
    >
      {{ t('navbar.dashboard') }}
    </a>
    <a
      class="auth-navbar__link"
      [routerLink]="['/', streamer(), 'commands']"
      routerLinkActive
      #commandsLink="routerLinkActive"
      [class.auth-navbar__link--active]="commandsLink.isActive"
    >
      {{ t('navbar.commands') }}
    </a>
    <a
      class="auth-navbar__link"
      [routerLink]="['/', streamer(), 'modules']"
      routerLinkActive
      #modulesLink="routerLinkActive"
      [class.auth-navbar__link--active]="modulesLink.isActive"
    >
      {{ t('navbar.modules') }}
    </a>
    <a
      class="auth-navbar__link"
      [routerLink]="['/', streamer(), 'settings']"
      routerLinkActive
      #settingsLink="routerLinkActive"
      [class.auth-navbar__link--active]="settingsLink.isActive"
    >
      {{ t('navbar.settings') }}
    </a>
    <a
      class="auth-navbar__link"
      [routerLink]="['/', streamer(), 'admin-hub']"
      routerLinkActive
      #adminHubLink="routerLinkActive"
      [class.auth-navbar__link--active]="adminHubLink.isActive"
    >
      {{ t('navbar.adminHub') }}
    </a>
  </nav>

  <!-- Profile dropdown (right) -->
  <div class="auth-navbar__profile" (clickOutside)="closeDropdown()">
    <button
      type="button"
      class="auth-navbar__avatar-btn"
      (click)="toggleDropdown()"
      [attr.aria-haspopup]="true"
      [attr.aria-expanded]="isDropdownOpen()"
    >
      <img [src]="userAvatar() || getDefaultAvatar()" [alt]="userName()" class="auth-navbar__avatar-img" />
    </button>

    @if (isDropdownOpen()) {
      <div class="auth-navbar__dropdown">
        <div class="auth-navbar__dropdown-header">
          <span class="auth-navbar__username">{{ userName() }}</span>
          <span class="auth-navbar__plan-badge" [class]="'auth-navbar__plan-badge--' + planTier()">
            {{ planTierLabel() }}
          </span>
        </div>

        <div class="auth-navbar__divider"></div>

        <a class="auth-navbar__dropdown-item" [routerLink]="['/', streamer(), 'profile']" (click)="closeDropdown()">
          <span class="auth-navbar__dropdown-icon">⚙️</span>
          <span>{{ t('navbar.profileSettings') }}</span>
        </a>

        <div class="auth-navbar__divider"></div>

        <button type="button" class="auth-navbar__dropdown-item" (click)="toggleTheme()">
          <span class="auth-navbar__dropdown-icon">{{ isDarkMode() ? '☀️' : '🌙' }}</span>
          <span>@if (isDarkMode()) { {{ t('navbar.light') } } @else { {{ t('navbar.dark') } }</span>
        </button>
        <button type="button" class="auth-navbar__dropdown-item" (click)="toggleLanguage()">
          <span class="auth-navbar__dropdown-icon">🌐</span>
          <span>{{ languageLabel() }}</span>
        </button>

        <div class="auth-navbar__divider"></div>

        <button type="button" class="auth-navbar__dropdown-item auth-navbar__dropdown-item--danger" (click)="logout()">
          <span class="auth-navbar__dropdown-icon">🚪</span>
          <span>{{ t('navbar.logout') }}</span>
        </button>
      </div>
    }
  </div>
</header>
```

### 3. Navbar Styling
**File**: `dimasite/src/styles.css`

Add after existing `.auth-navbar` styles:

```css
/* Profile section */
.auth-navbar__profile {
  position: relative;
  margin-left: auto;
}

.auth-navbar__avatar-btn {
  width: 2.75rem;
  height: 2.75rem;
  border-radius: 9999px;
  border: 2px solid color-mix(in srgb, var(--ring) 40%, transparent);
  background: color-mix(in srgb, var(--surface) 72%, transparent);
  cursor: pointer;
  padding: 0;
  overflow: hidden;
  transition: border-color var(--transition-base), box-shadow var(--transition-base), transform var(--transition-base);
}

.auth-navbar__avatar-btn:hover,
.auth-navbar__avatar-btn:focus {
  border-color: color-mix(in srgb, var(--ring) 70%, transparent);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--ring) 20%, transparent);
  transform: scale(1.05);
}

.auth-navbar__avatar-btn:focus {
  outline: none;
}

.auth-navbar__avatar-img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  object-position: center;
}

/* Dropdown menu */
.auth-navbar__dropdown {
  position: absolute;
  top: calc(100% + 0.5rem);
  right: 0;
  min-width: 16rem;
  border-radius: 0.85rem;
  border: 1px solid color-mix(in srgb, var(--ring) 28%, transparent);
  background: color-mix(in srgb, var(--surface) 88%, transparent);
  backdrop-filter: blur(14px);
  box-shadow: 0 12px 32px rgba(79, 25, 145, 0.18);
  padding: 0.4rem 0;
  animation: dropdown-fade-in 180ms ease-out;
  z-index: 40;
}

@keyframes dropdown-fade-in {
  from {
    opacity: 0;
    transform: translateY(-8px) scale(0.96);
  }
  to {
    opacity: 1;
    transform: translateY(0) scale(1);
  }
}

.auth-navbar__dropdown-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.6rem;
  padding: 0.6rem 0.8rem;
}

.auth-navbar__username {
  font-weight: 700;
  font-size: 0.9rem;
  color: var(--text);
  max-width: 8rem;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* Plan tier badges */
.auth-navbar__plan-badge {
  border-radius: 9999px;
  padding: 0.25rem 0.6rem;
  font-size: 0.68rem;
  font-weight: 800;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  white-space: nowrap;
}

.auth-navbar__plan-badge--free {
  background: color-mix(in srgb, #6b7280 12%, var(--surface));
  color: #6b7280;
  border: 1px solid color-mix(in srgb, #6b7280 25%, transparent);
}

.auth-navbar__plan-badge--premium {
  background: linear-gradient(135deg, color-mix(in srgb, #d97706 8%, var(--surface)), color-mix(in srgb, #f59e0b 6%, var(--surface)));
  color: #b45309;
  border: 1px solid color-mix(in srgb, #d97706 30%, transparent);
}

.auth-navbar__plan-badge--pro {
  background: linear-gradient(135deg, #f59e0b, #fbbf24);
  color: #78350f;
  border: 1px solid color-mix(in srgb, #d97706 45%, transparent);
  box-shadow: 0 0 12px rgba(245, 158, 11, 0.35);
}

/* Dropdown divider */
.auth-navbar__divider {
  height: 1px;
  background: color-mix(in srgb, var(--ring) 18%, transparent);
  margin: 0.3rem 0.5rem;
}

/* Dropdown items */
.auth-navbar__dropdown-item {
  width: 100%;
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.5rem 0.8rem;
  border: 0;
  background: transparent;
  color: var(--text);
  font-size: 0.86rem;
  font-weight: 600;
  text-align: left;
  cursor: pointer;
  transition: background-color var(--transition-base);
  text-decoration: none;
}

.auth-navbar__dropdown-item:hover {
  background: color-mix(in srgb, var(--ring) 12%, var(--surface));
}

.auth-navbar__dropdown-item:focus {
  outline: none;
  background: color-mix(in srgb, var(--ring) 12%, var(--surface));
}

.auth-navbar__dropdown-item--danger {
  color: #dc2626;
}

.auth-navbar__dropdown-item--danger:hover {
  background: color-mix(in srgb, #ef4444 10%, var(--surface));
}

.auth-navbar__dropdown-icon {
  font-size: 0.95rem;
  min-width: 1.2rem;
  text-align: center;
}
```

### 4. Add Routes
**File**: `dimasite/src/app/app.routes.ts`

Add under authenticated children (after 'admin-hub' route):

```typescript
{
  path: 'modules',
  loadComponent: () => import('./features/modules/modules-page.component').then((m) => m.ModulesPageComponent),
  canActivate: [permissionGuard],
  data: {
    permission: 'dashboard:view'
  },
  title: 'Modules | DomDimaBot'
},
{
  path: 'profile',
  loadComponent: () => import('./features/profile/profile-page.component').then((m) => m.ProfilePageComponent),
  canActivate: [permissionGuard],
  data: {
    permission: 'settings:view'
  },
  title: 'Profile | DomDimaBot'
}
```

### 5. Create Modules Page Component
**File**: `dimasite/src/app/features/modules/modules-page.component.ts`

```typescript
import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { LanguageService } from '../../services/language.service';

@Component({
  selector: 'app-modules-page',
  standalone: true,
  templateUrl: './modules-page.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class ModulesPageComponent {
  protected readonly languageService = inject(LanguageService);

  t(key: string): string {
    return this.languageService.translate(key);
  }
}
```

**File**: `dimasite/src/app/features/modules/modules-page.component.html`

```html
<div class="placeholder-page">
  <h1>{{ t('modules.title') }}</h1>
  <p>{{ t('modules.subtitle') }}</p>
</div>
```

### 6. Create Profile Page Component
**File**: `dimasite/src/app/features/profile/profile-page.component.ts`

```typescript
import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { LanguageService } from '../../services/language.service';

@Component({
  selector: 'app-profile-page',
  standalone: true,
  templateUrl: './profile-page.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class ProfilePageComponent {
  protected readonly languageService = inject(LanguageService);

  t(key: string): string {
    return this.languageService.translate(key);
  }
}
```

**File**: `dimasite/src/app/features/profile/profile-page.component.html`

```html
<div class="placeholder-page">
  <h1>{{ t('profile.title') }}</h1>
  <p>{{ t('profile.subtitle') }}</p>
</div>
```

### 7. Update Translation Files
**File**: `dimasite/src/assets/i18n/en.json`

Update navbar section:
```json
"navbar": {
  "dashboard": "Dashboard",
  "commands": "Commands",
  "modules": "Modules",
  "settings": "Settings",
  "adminHub": "Admin Hub",
  "dark": "Dark",
  "light": "Light",
  "logout": "Logout",
  "profileSettings": "Profile Settings"
},
"modules": {
  "title": "Modules",
  "subtitle": "Module management coming soon."
},
"profile": {
  "title": "Profile Settings",
  "subtitle": "Manage your account settings and preferences."
}
```

**File**: `dimasite/src/assets/i18n/es.json`

Update navbar section:
```json
"navbar": {
  "dashboard": "Panel",
  "commands": "Comandos",
  "modules": "Modulos",
  "settings": "Configuracion",
  "adminHub": "Hub Admin",
  "dark": "Oscuro",
  "light": "Claro",
  "logout": "Cerrar sesion",
  "profileSettings": "Configuracion de Perfil"
},
"modules": {
  "title": "Modulos",
  "subtitle": "Gestion de modulos proximamente."
},
"profile": {
  "title": "Configuracion de Perfil",
  "subtitle": "Gestiona la configuracion de tu cuenta y preferencias."
}
```

## Implementation Order

1. Update translation files (en.json, es.json)
2. Create new page components (modules, profile)
3. Update routes to include /modules and /profile
4. Update authenticated layout component logic (.ts)
5. Redesign navbar template (.html)
6. Add navbar styling to styles.css
7. Test navigation and dropdown functionality

## Accessibility Features

- Avatar button with `aria-haspopup` and `aria-expanded`
- Keyboard navigation for dropdown items
- Click outside to close dropdown
- Escape key to close dropdown (to be added)
- Proper focus management when dropdown opens/closes
