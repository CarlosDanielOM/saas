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

### Live First (required for production UI)

**Canonical design language for all new and migrated dimasite surfaces.**

- Skill (read first for any UI work): `.opencode/skills/live-first/SKILL.md` (also `.claude/skills/live-first/SKILL.md`)
- Origin mock: `/mocks/grok/oc3c` (OC3c · Live First)
- Product reference mocks: `/mocks/dev/prod-dashboard`, `/mocks/dev/prod-commands`
- Production examples: landing `/`, tip `/tip/:streamer`, dashboard `/:streamer/dashboard`, auth shell `AuthenticatedLayoutComponent`

**Rules:**

1. Use Live First **structure** (bento + `lf-tile` / shell patterns), not a recolor of legacy glass/aurora layouts.
2. Page tokens on `:host` / `:host-context(html.dark)`: `--bg`, `--tile`, `--fg`, `--muted`, `--line`, `--accent`, `--live`, `--gold`, `--radius`, `--shadow`, `--font` (Plus Jakarta Sans).
3. Authenticated app: layout owns full-bleed background + navbar; `auth-layout__content` has **no** padding; page `.lf-main` provides max-width gutters only.
4. Public pages: page owns background + sticky LF nav (brand pulse, language, theme, primary CTA).
5. Prefer component-scoped `*.component.css` for page DNA; keep global `styles.css` for shared tokens/utilities only.
6. Mobile-first (`min-width`), touch targets ≥ 44px, respect `prefers-reduced-motion`.
7. Plan tier: `data-plan-tier` on `<html>` and/or `[attr.data-plan]` on page root — gold accents for premium/pro.

### Legacy global tokens

Older surfaces may still use `:root` / `.dark` tokens (`--surface`, `--text`, `--ring`). Do not expand those for new work; migrate toward Live First.

### Plan-Tier Styling

- Use `plan_tier` (`free|premium|pro`) as the source of truth.
- Premium users: subtle gold accents (borders, glow, highlight details).
- Pro users: stronger gold treatment than premium while maintaining WCAG AA contrast.
- Free users: default visual treatment.
- Prefer applying tier styles through a global attribute hook (e.g., `data-plan-tier` on `<html>`) so future components can reuse the system.

### Typography & Spacing

- Live First pages: Plus Jakarta Sans + LF spacing scale from the skill.
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

## Production Build & Deployment

This checkout is on the production host. Use `scripts/saas-ops` target `site` for preview, isolated build, verification, and publication as part of a requested implementation unless the user limits scope. See [`../ops/README.md`](../ops/README.md). `scripts/dima-update` is the human operator's manual tool; agents must not invoke or modify it.

### Preview and validate first

From the repository root, use an unused loopback port, for example:

```bash
scripts/saas-ops preview site --port 4201
```

The helper starts `ng serve` in a temporary source copy on loopback. Inspect the development environment and API/proxy targets before exercising interactions; development mode does not guarantee isolated data. Verify changed flows and mobile/desktop layouts. Ctrl-C stops the preview and removes its copy.

### Build command

From `saas/` root:

```bash
scripts/saas-ops build site
# Use the exact generated run ID and a check covering the changed feature:
scripts/saas-ops verify site-<run-id> --check <behavior-script>
scripts/saas-ops deploy site-<run-id>
scripts/saas-ops cleanup site-<run-id>
```

The helper runs `npm ci` and the production build in an unserved snapshot. Verification serves that exact bundle on loopback; a successful deploy backs up the live bundle, publishes assets before HTML, and verifies the served entrypoints. Deployment writes to:

```
dimasite/dist/dimasite/browser/
```

### Hybrid rendering (prerender + CSR)

The app uses Angular hybrid rendering (`outputMode: "static"`, no Node SSR server):

- `src/app/app.routes.server.ts` assigns render modes. `/` is prerendered
  (`RenderMode.Prerender`); every other route is `RenderMode.Client`.
- `src/app/app.config.server.ts` + `src/main.server.ts` are the build-time server entry.
- Client hydration is enabled in `app.config.ts` via
  `provideClientHydration(withEventReplay())`.
- Build output in `dist/dimasite/browser/`:
  - `index.html` — **prerendered landing page** (static marketing content,
    SEO meta, empty live board; no SSE telemetry baked in).
  - `index.csr.html` — CSR shell that must be served for all non-prerendered
    routes (`/login`, `/:streamer/*`, mocks, status pages, unknown paths).
- The landing live board (`SiteAnalyticsService`) connects to its SSE endpoint
  **only in the browser** (`isPlatformBrowser` guard). Do not remove that guard.
- Only add new prerendered routes for genuinely public, static, indexable
  marketing pages. Never prerender authenticated, mock, or live-data-driven
  content.

### How the bundle reaches production

The `dimabot-site` nginx container (owned by `dimasite/docker-compose.yaml`, with Nginx Proxy Manager in front) has a **read-only bind-mount**:

```
host:        /root/saas/dimasite/dist/dimasite/browser
container:   /usr/share/nginx/html
```

Nginx reads files on every request. A direct in-place Angular build could clear live output before finishing, so agents use the helper's separate build/publication steps. It preserves the mounted directory and replaces files individually with HTML last; publication is not a whole-site atomic switch. **No container restart or service reload is needed for bundle changes.**

### Required nginx routing rule (hybrid rendering)

With prerendering enabled, the SPA fallback target changes from `index.html`
to `index.csr.html`, otherwise CSR routes would receive the prerendered
landing DOM and hydration would mismatch. The `location /` block in
`dimasite/nginx.conf` is:

```nginx
location / {
  try_files $uri $uri/index.html /index.csr.html;
}
```

- `/` resolves to the prerendered `index.html` via `$uri/index.html`.
- Static assets (chunks, fonts, `robots.txt`, `sitemap.xml`, `og-image.jpg`) resolve via `$uri`.
- Everything else falls back to `index.csr.html` and bootstraps as CSR.

`dimasite/nginx.conf` is bind-mounted into the `dimabot-site` container
(`nginx:alpine`, stock image — there is no custom image to rebuild) as
`/etc/nginx/conf.d/default.conf`. Unlike the content bind-mount, **config
changes are not picked up per-request**. Validate the candidate configuration in an isolated nginx container before applying it. After applying a validated config change, check and reload the production nginx process:

```bash
docker exec dimabot-site nginx -t
# Only after the configuration check succeeds:
docker exec dimabot-site nginx -s reload
```

### Verify the deploy

```bash
# Confirm bundle timestamp updated on host
stat -c '%y' /root/saas/dimasite/dist/dimasite/browser/index.html

# Confirm the served bundle has new chunk hashes
curl -s https://domdimabot.com/ | grep -oE 'main-[A-Z0-9]+\.js'

# Confirm the count-up directive / new code is in the served bundle
curl -s https://domdimabot.com/main-<HASH>.js | head -c 200
```

The new entry chunk will have a different content hash than the previous build (e.g. `main-ZC6TJKTU.js`). Cross-check it against `dimasite/dist/dimasite/browser/main-*.js`.

### Important do-nots

- Deploy to the actual mounted output path above; confirm mounts before assuming another checkout or web directory is served.
- **Do not** restart the `dimabot-site` container after a frontend change — nginx picks up file changes per-request.
- **Do not** commit `dimasite/dist/` — it is gitignored at both root (`/root/saas/.gitignore`) and per-project (`dimasite/.gitignore`).
- Use the helper's publication/rollback commands for bundles. Do not rename the mounted output directory or publish a development build. The helper retains old assets for open browser tabs and removes obsolete HTML entrypoints.

### Why no flags?

`ng build` with no arguments uses `defaultConfiguration: "production"` in `angular.json`, enabling production optimization and hashing. Use `--configuration development` for isolated previews; never publish development output into the live mount.

---

**This file is the authoritative design-system and Angular-pattern guide for `dimasite/`.** Update it when visual language, component conventions, or Angular best practices evolve. Root `saas/AGENTS.md` takes precedence for monorepo-wide rules.
