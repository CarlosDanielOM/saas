# DomDimaBot v21 Implementation Plan

## Overview

Build a modern Angular v21 version of the DomDimaBot website using `dima-site/` (Angular v17) as the reference. The new site will feature a purple-themed design with dark/light mode support, responsive design for mobile/desktop, and leverage Three.js for 3D effects where appropriate.

**Target Directory:** `dimasite/`
**Reference Directory:** `dima-site/`
**Angular Version:** v21
**Key Dependencies:** `three@0.183.2`, `lucide-angular`, `@tailwindcss/postcss`

---

## Design System

### Color Palette (Purple Theme)

**Primary Colors:**
- Primary: `#8b5cf6` (purple-500)
- Primary Dark: `#7c3aed` (purple-600)
- Primary Light: `#a78bfa` (purple-400)
- Secondary: `#a855f7` (fuchsia-500)
- Accent: `#c4b5fd` (violet-300)

**Light Mode:**
- Background: `#fafafa` (gray-50)
- Surface: `#ffffff`
- Text: `#27272a` (zinc-800)
- Text Muted: `#71717a` (zinc-500)

**Dark Mode:**
- Background: `#18181b` (zinc-900)
- Surface: `#27272a` (zinc-800)
- Text: `#fafafa`
- Text Muted: `#a1a1aa` (zinc-400)

### Typography
- Font Family: System UI stack (San Francisco, Segoe UI, Roboto, etc.)
- Headings: Bold, tight tracking
- Body: Normal, comfortable line height (1.6)

### Visual Effects
- Aurora blobs with parallax scrolling (3 animated layers)
- Glassmorphism cards (backdrop blur + transparency)
- Gradient text animations
- Smooth transitions (200ms - 500ms cubic-bezier)
- Scroll reveal animations
- Icon glow effects

---

## Phase 1: Project Setup & Infrastructure

### 1.1 Configuration Files

**Create `tailwind.config.js`:**
```javascript
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
      }
    }
  },
  safelist: [
    // Include critical spacing utilities
    'space-x-1', 'space-x-2', 'space-x-3', 'space-x-4', 'space-x-6',
    'space-y-1', 'space-y-2', 'space-y-3', 'space-y-4', 'space-y-6',
    'gap-1', 'gap-2', 'gap-3', 'gap-4', 'gap-6',
  ]
}
```

**Update environment files:**
- Copy from `dima-site/src/environments/`

### 1.2 Core Styles

**Update `src/styles.css`:**
```css
@import "tailwindcss";

/* CSS Variables for theming */
:root {
  --color-primary: #8b5cf6;
  --color-primary-dark: #7c3aed;
  --transition-fast: 0.2s cubic-bezier(0.4, 0, 0.2, 1);
  --transition-base: 0.3s cubic-bezier(0.4, 0, 0.2, 1);
}

/* Aurora blob animations */
@keyframes aurora-drift {
  0% { transform: translate3d(0, 0, 0) scale(1) rotate(0deg); }
  50% { transform: translate3d(8%, -6%, 0) scale(1.08) rotate(10deg); }
  100% { transform: translate3d(-6%, 4%, 0) scale(1.02) rotate(-8deg); }
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
  border: 1px solid rgba(255, 255, 255, 0.35);
  box-shadow: 0 10px 30px rgba(124, 58, 237, 0.08);
}

.dark .glass-card {
  background: rgba(39, 39, 42, 0.7);
  border: 1px solid rgba(124, 58, 237, 0.2);
}

/* Scroll reveal */
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
}

.btn-gradient:hover {
  transform: translateY(-2px);
  box-shadow: 0 16px 32px rgba(124,58,237,0.35);
  filter: brightness(1.05);
}
```

### 1.3 Asset Structure

**Create directories:**
```
src/assets/
  i18n/
    en.json
    es.json
  images/
    (copy favicon from dima-site/public)
```

---

## Phase 2: Core Services & Infrastructure

### 2.1 Core Services

Create in `src/app/services/` (port from dima-site):

1. **`user.service.ts`** - User auth & session (use signals)
2. **`auth.service.ts`** - Auth API calls (HttpClient)
3. **`language.service.ts`** - i18n (signals, 'en'/'es')
4. **`theme.service.ts`** - Dark/light mode (signals)
5. **`websocket.service.ts`** - WebSocket connections
6. **`links.service.ts`** - External links
7. **`toast.service.ts`** - Toast notifications
8. **`commands.service.ts`** - Commands API
9. **`triggers.service.ts`** - Triggers API
10. **`redemptions.service.ts`** - Redemptions API
11. **`user-events.service.ts`** - User state events

### 2.2 Guards

Create `src/app/guards/`:
- **`permission.guard.ts`** - Check auth & premium level
- **`authenticated.guard.ts`** - Ensure user is logged in

### 2.3 Directives

Create `src/app/directives/`:
- **`count-up.directive.ts`** - Animate numbers on scroll
- **`block-inactive-user.directive.ts`** - Block inactive users

### 2.4 Models

Create `src/app/core/models/`:
- **`user.model.ts`** - User interface

---

## Phase 3: Landing Page (Eager-Loaded)

### 3.1 Component

**Create `src/app/features/landing/landing-page.component.ts`:**
- Standalone, signals for state
- WebSocket listeners for analytics
- IntersectionObserver for scroll reveal
- Parallax aurora blobs
- Count-up directive for stats

### 3.2 Sections

- Hero with gradient text
- Analytics with live stats (WebSocket)
- Features with glass cards
- Pricing (Basic, Premium, AI)
- CTA
- Footer with language toggle

### 3.3 Three.js Enhancement (Optional)

Add subtle 3D particle background or floating shapes in hero section using `three`.

---

## Phase 4: Authentication Flow

### 4.1 Login Page

**Create `src/app/features/auth/login/login.component.ts`:**
- Handle Twitch OAuth callback
- Validate token
- Store session
- Redirect to dashboard

### 4.2 Logout Page

**Create `src/app/features/auth/logout/logout.component.ts`:**
- Clear session
- Redirect to landing

---

## Phase 5: Authenticated Layout (Lazy-Loaded)

### 5.1 Layout Component

**Create `src/app/features/layout/authenticated-layout.component.ts`:**
- Load navbar/sidebar
- Router outlet for children
- Theme/language toggles

### 5.2 Navbar

**Create `src/app/features/layout/navbar/navbar.component.ts`:**
- User dropdown with avatar
- Nav links (Dashboard, Modules, Settings)
- Bot activation/update indicators
- Theme toggle
- Language toggle
- Mobile menu
- Glassmorphic when scrolled

### 5.3 Sidebar

**Create `src/app/features/layout/sidebar/sidebar.component.ts`:**
- Collapsible
- Module navigation
- Active route highlighting
- Hidden on mobile

---

## Phase 6: Dashboard (Lazy-Loaded)

### 6.1 Component

**Create `src/app/features/dashboard/dashboard.component.ts`:**
- ECharts integration (ngx-echarts)
- Live analytics
- KPI cards
- Recent activity
- Bot status

---

## Phase 7: Commands Module (Lazy-Loaded)

### 7.1 Commands List

**Create `src/app/features/commands/commands.component.ts`:**
- List commands
- Create/Edit/Delete
- Command types (simple, custom, AI)

### 7.2 Command Form

**Create `src/app/features/commands/command-form.component.ts`:**
- Signal forms
- Validation
- Code editor for custom commands

---

## Phase 8: Modules System (Lazy-Loaded)

### 8.1 Overview

**Create `src/app/features/modules/modules.component.ts`:**
- Grid of modules
- Module cards with status

### 8.2 Individual Modules

- **`clips/`** - Clips management
- **`chat-events/`** - Event configuration
- **`redemptions/`** - Channel points rewards
- **`triggers/`** - Trigger management (premium only)

---

## Phase 9: Settings Pages (Lazy-Loaded)

### 9.1 Settings

**Create `src/app/features/settings/settings.component.ts`:**
- Bot settings
- Channel settings
- Premium only

### 9.2 Profile Settings

**Create `src/app/features/settings/profile-settings.component.ts`:**
- User profile
- Premium Plus only

---

## Phase 10: WIP Component

**Create `src/app/shared/wip/wip.component.ts`:**
- Reusable with progress indicator
- Dynamic accent colors
- Animated progress ring
- Fade-in animations

---

## Phase 11: Routing

**Update `src/app/app.routes.ts`:**

```typescript
export const routes: Routes = [
  // Public routes
  { path: 'login', loadComponent: () => import('./features/auth/login/login.component').then(m => m.LoginComponent) },
  { path: 'logout', loadComponent: () => import('./features/auth/logout/logout.component').then(m => m.LogoutComponent) },

  // Landing (eager)
  { path: '', loadComponent: () => import('./features/landing/landing-page.component').then(m => m.LandingPageComponent) },
  { path: ':streamer', loadComponent: () => import('./features/landing/landing-page.component').then(m => m.LandingPageComponent) },

  // Authenticated routes (lazy)
  {
    path: ':streamer',
    loadComponent: () => import('./features/layout/authenticated-layout.component').then(m => m.AuthenticatedLayoutComponent),
    canActivate: [authenticatedGuard],
    children: [
      {
        path: 'dashboard',
        loadComponent: () => import('./features/dashboard/dashboard.component').then(m => m.DashboardComponent),
        canActivate: [permissionGuard],
        data: { permission: { requiredLevel: 'everyone' } }
      },
      {
        path: 'commands',
        loadComponent: () => import('./features/commands/commands.component').then(m => m.CommandsComponent),
        canActivate: [permissionGuard],
        data: { permission: { requiredLevel: 'everyone' } }
      },
      // ... more routes
    ]
  },

  { path: '**', redirectTo: '' }
];
```

---

## Phase 12: Shared Components

Create in `src/app/shared/`:
- Modals (setup, create-trigger, create-reward, confirmation, upload-media)
- `media-library-sidebar.component.ts`
- `toast/toast.component.ts`
- `tooltip/tooltip.component.ts`

---

## Phase 13: App Configuration

### 13.1 App Component

**Update `src/app/app.ts`:**
- Initialize theme/language on load
- Add `data-theme` attribute

### 13.2 Main & Index HTML

- Update `src/main.ts`
- Update `src/index.html` with fonts & meta tags

---

## Phase 14: Testing & Optimization

- Verify lazy loading works
- Optimize images (WebP)
- Code split heavy libraries
- Run axe DevTools for accessibility
- Test mobile/tablet/desktop
- Cross-browser testing

---

## Phase 15: Three.js Integration

Add to landing page hero:
- Particle system for chat messages
- Floating geometric shapes
- Interactive elements

Keep performance-friendly:
- Low poly count
- Simple shaders
- Proper cleanup in ngOnDestroy

---

## Implementation Order

1. Project setup (configs, styles, assets)
2. Core services & infrastructure
3. Landing page (eager-loaded)
4. Authentication flow
5. Authenticated layout (navbar, sidebar)
6. Dashboard
7. Commands module
8. Modules system
9. Settings pages
10. WIP component
11. Shared components
12. Route configuration
13. App configuration
14. Three.js enhancements
15. Testing & optimization
16. Final polish

---

## Technical Decisions

- **Signals vs RxJS**: Signals for local state, RxJS for HTTP/WebSocket
- **Standalone Components**: All components standalone (v21 default)
- **Forms**: Signal forms for new features, ReactiveFormGroup for complex
- **Styling**: Tailwind CSS + global styles.css
- **Lazy Loading**: `loadComponent()` for routes, landing eager-loaded
- **i18n**: Custom service (en/es)
- **Accessibility**: Semantic HTML, ARIA labels, WCAG AA

---

## Success Criteria

✅ Landing page loads instantly with purple design
✅ Dark/light mode works across all pages
✅ Mobile responsive on all breakpoints
✅ Routes configured with guards
✅ WebSocket works for analytics
✅ Auth flow works
✅ Commands module functional
✅ All modules work
✅ Permission guards enforce tiers
✅ Three.js performant
✅ Accessibility standards met
✅ Bundle optimized
✅ i18n works for EN/ES

---

## Notes

Reference `dima-site/` for business logic and API contracts. Improve upon it with v21 patterns, better typing, cleaner code. Maintain API compatibility. Follow purple design system. Add Three.js strategically without hurting performance.

Start with Phase 1 and work systematically. Focus on landing page first, then auth, then authenticated sections.

Good luck! 🚀
