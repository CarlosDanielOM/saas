# dimasite Agent Guide

**This document supplements the root `saas/AGENTS.md`.** Read the root file first for monorepo rules, then return here for Angular-specific patterns, design system, and component guidelines.

## TypeScript Best Practices

- Use strict type checking.
- Prefer type inference when the type is obvious.
- Avoid the `any` type; use `unknown` when type is uncertain.

## Angular Best Practices

- Always use standalone components (default in v20+).
- Must NOT set `standalone: true` inside Angular decorators.
- Use signals for state management (`input()`, `output()`, `computed()`, `inject()`).
- Implement lazy loading for feature routes.
- Do NOT use `@HostBinding` / `@HostListener`. Put host bindings inside the `host` object of the decorator.
- Use `NgOptimizedImage` for all static images (does not work for inline base64).
- Set `changeDetection: ChangeDetectionStrategy.OnPush` in `@Component` decorator.
- Prefer Reactive forms over Template-driven forms.

## State Management

- Use signals for local component state.
- Use `computed()` for derived state.
- Keep state transformations pure and predictable.
- Do NOT use `mutate` on signals; use `update` or `set` instead.

## Templates

- Keep templates simple and avoid complex logic.
- Use native control flow (`@if`, `@for`, `@switch`) instead of `*ngIf`, `*ngFor`, `*ngSwitch`.
- Use the async pipe to handle observables.
- Do not assume globals like `new Date()` are available.
- Do not write arrow functions in templates.

## Services

- Design services around a single responsibility.
- Use `providedIn: 'root'` for singleton services.
- Use `inject()` instead of constructor injection.

## Accessibility Requirements

- Must pass all AXE checks.
- Must follow all WCAG AA minimums (focus management, color contrast, ARIA).

---

## Styling Policy (Updated – Hybrid Approach)

**Goal**: Keep global `styles.css` focused on design tokens and truly shared concerns while allowing substantial component/page styles to live in their own files.

### Global `styles.css` – Only

- Design tokens (CSS custom properties)
- Theme variables (light/dark)
- Global resets, typography, layout primitives
- Shared utility classes used across many components
- Plan-tier styling hooks (`plan_tier` attribute or CSS variable)

### Component `*.component.css` – Encouraged For

- Page-level layouts and sections
- Complex reusable components (modals, tables, dashboards, feature pages)
- Any styling that would push `styles.css` beyond ~3–4k lines of core tokens

### Budget Awareness

- Angular `anyComponentStyle` budget: 50 kB warning / 100 kB error.
- If a single component stylesheet exceeds ~800–1000 lines, consider extracting shared pieces into a global partial or `shared/` stylesheet.

### Migration Note

Large existing component stylesheets (triggers, dimafx, follow-defense, etc.) may remain in place. **New work should prefer component-scoped files** unless the styles are genuinely global.

---

## Responsive Design Priority

- **Mobile-first approach**: Design and implement for the smallest viewport first (320px–480px base).
- Progressively enhance for tablet (768px+) and desktop (1024px+) breakpoints.
- Prefer `min-width` media queries over `max-width` (mobile-first).
- Always test layouts on real mobile devices or mobile emulation before considering desktop complete.

## Design System & Visual Language

### Color Palette & Theme

- Light theme tokens live in `:root`.
- Dark theme tokens live in `.dark`.
- Primary brand color family: purple/violet (`--ring`, surface accents).
- Use CSS custom properties (`var(--surface)`, `var(--text)`, etc.) instead of hard-coded colors.

### Plan-Tier Styling

- Use `plan_tier` (`free|premium|pro`) as the source of truth.
- Premium users: subtle gold accents (borders, glow, highlight details).
- Pro users: stronger gold treatment than premium while maintaining WCAG AA contrast.
- Free users: default visual treatment.
- Prefer applying tier styles through a global attribute hook (e.g., `data-plan-tier` on `<html>`) so future components can reuse the system.

### Typography & Spacing

- Use the design tokens defined in `styles.css` for consistent spacing and typography.
- Avoid one-off pixel values when a token exists.

### i18n

- All user-facing strings go through `LanguageService` (signal-based).
- Translation files: `src/assets/i18n/{en,es}.json`.
- Never hard-code English strings in templates or components.

---

## Routing & Guards

- Authenticated routes live under `/:streamer` and use `AuthenticatedLayoutComponent`.
- Guards:
  - `authenticatedGuard` – ensures user is logged in.
  - `dashboardAccessGuard` – checks streamer ownership / permissions.
  - `streamerRouteShapeGuard` – validates route shape against `MODULE_CHILDREN` whitelist.
  - **Important**: Any new authenticated module route (e.g. `library`) **must** be added to the `MODULE_CHILDREN` map in `src/app/guards/streamer-route.guard.ts` for users to be able to access it.
- Lazy-load feature modules when possible.

---

## Component Patterns

- Keep components small and focused on a single responsibility.
- Use `input()` / `output()` functions (not decorators).
- Use `computed()` for derived state.
- Prefer inline templates for small components.
- When using external templates/styles, use paths relative to the component `.ts` file.

---

## When to Create a New Component vs. Extend Existing

- New page or major feature section → new component + route.
- Reusable UI block used in 2+ places → shared component in `shared/`.
- One-off visual treatment for a single page → keep inside the page component's CSS file.

---

**This file is the authoritative design-system and Angular-pattern guide for `dimasite/`.** Update it when visual language, component conventions, or Angular best practices evolve. Root `saas/AGENTS.md` takes precedence for monorepo-wide rules.
