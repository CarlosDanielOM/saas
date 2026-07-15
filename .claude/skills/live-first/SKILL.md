---
name: live-first
description: Live First (OC3c) design language for dimasite production UI. Use when building, migrating, restyling, or reviewing any dimasite page/component — landing, tip, dashboard, auth shell, commands, modules, settings, or new frontend surfaces. Keywords: Live First, OC3c, bento, lf-tile, lf-bento, design system, dimasite UI, navbar, dashboard layout.
---

# Live First Design Language (dimasite)

**Canonical production design system for DomDimaBot’s public site + authenticated app.**

- Origin: OpenCode mock **OC3c · Live First** (`/mocks/grok/oc3c`)
- Productized: landing, tip, dashboard, authenticated layout
- Reference mocks: `/mocks/dev/prod-dashboard`, `/mocks/dev/prod-commands`

When working on **any** `dimasite/` UI, follow this skill by default. Do **not** invent a new visual language or revert to aurora/glassmorphic cyan shells.

## When to use

- New pages/components in `dimasite/`
- Migrating legacy pages to production design
- Navbar / shell / layout work
- Dashboard, commands, modules, settings, tip, landing, login polish
- Mentions of “Live First”, “bento”, “OC3c”, or “match the new design”

## Core principles

1. **Bento over sections** — content in rounded tiles on a soft radial background, not glass cards in a colored shell.
2. **Full-bleed app chrome** — authenticated pages fill the site; layout owns background. No nested “page card” with outer site padding.
3. **Proof / live first** — live state, channel identity, metrics are first-class (chips, spotlight, pulse dots).
4. **Tokens only** — `:host` LF CSS variables; no one-off hard-coded palette in templates.
5. **Mobile-first** — base 320–480px; enhance with `min-width` (640 / 960).
6. **Keep data wiring** — restyle/restructure markup; do not rewrite working services/APIs unless asked.
7. **i18n** — all user strings via `LanguageService` + `en.json` / `es.json`.

## Design tokens

Put these on the page/shell `:host` (and dark via `:host-context(html.dark)`):

| Token | Light | Dark |
|-------|-------|------|
| `--bg` | `#f4f5f8` | `#0f1115` |
| `--tile` | `#ffffff` | `#171a21` |
| `--fg` | `#14151a` | `#f5f7fb` |
| `--muted` | `#667085` | `#9aa3b5` |
| `--line` | `rgba(15,17,21,.08)` | `rgba(255,255,255,.07)` |
| `--accent` | `#7c3aed` | `#8b5cf6` |
| `--accent-soft` | `rgba(124,58,237,.12)` | `rgba(139,92,246,.16)` |
| `--live` | `#ef4444` | `#ef4444` |
| `--live-soft` | `rgba(239,68,68,.12)` | `rgba(239,68,68,.14)` |
| `--ok` | `#15803d` | `#86efac` |
| `--gold` | `#b45309` | `#fbbf24` |
| `--gold-soft` | `rgba(180,83,9,.12)` | `rgba(251,191,36,.14)` |
| `--btn` | `#eef0f5` | `#1d2230` |
| `--btn-border` | `rgba(15,17,21,.1)` | `rgba(255,255,255,.07)` |
| `--kicker` / `--title-accent` | `#6d28d9` | `#c4b5fd` |
| `--radius` | `1.25rem`–`1.35rem` | same |
| `--shadow` | soft black ~8% | deeper ~35% |
| `--font` | `'Plus Jakarta Sans', 'Segoe UI', system-ui, sans-serif` | same |
| `--glow-a` | violet soft | violet soft |
| `--glow-b` | red soft | red soft |

**Font:** Plus Jakarta Sans is loaded in `dimasite/src/index.html`.

**Theme:** `html.dark` + `data-theme` via `ThemeService`. Prefer `:host-context(html.dark)`.

**Plan tier:** `data-plan-tier` on `<html>` (auth layout) and/or `[attr.data-plan]` on page root. Premium/pro → gold accents.

## Structural patterns

### Public page (landing, tip)

```
.lf  (or page root with tokens)
  header.lf-nav | sticky brand + tools + primary CTA
  main.lf-main  | max-width ~74rem, horizontal padding only
    .lf-bento.lf-bento--hero | intro + spotlight + metrics
    .lf-section / more bentos
  footer.lf-footer
```

### Authenticated page (dashboard, commands, …)

- Shell: `AuthenticatedLayoutComponent` owns background + navbar.
- Content: `auth-layout__content` has **zero padding**.
- Page root: `.lf` is **transparent / full-bleed**; only optional live glows.
- Inner: `.lf-main` has max-width + padding (the only gutter).

Do **not** wrap the whole page in an extra bordered shell card.

### Bento grids

| Class | Role |
|-------|------|
| `.lf-bento` | CSS grid, gap ~0.75–0.85rem |
| `.lf-bento--hero` | Intro + spotlight + metric tiles |
| `.lf-bento--ops` | Activity / actions / AI (or similar 3-up) |
| `.lf-bento--mid` | Chart + goals (~1.35fr / 1fr at desktop) |
| `.lf-tile` | Card: tile bg, 1px line, radius, soft shadow |
| `.lf-tile--intro` | Hero copy + primary actions |
| `.lf-tile--spotlight` | Live/channel focus; `.lf-spotlight--live` when live |
| `.lf-metric` | Compact KPI; `.lf-metric--accent` violet wash |

### Typography & chrome

| Class | Use |
|-------|-----|
| `.lf-kicker` | Uppercase micro label |
| `.lf-title` / `.lf-h2` / `.lf-h3` | Headings; accent line via `span` |
| `.lf-copy` / `.lf-note` | Body / helper |
| `.lf-label` / `.lf-value` | Metric labels/values (tabular nums) |
| `.lf-btn` / `.lf-btn--primary` | Pill buttons, min-height 44px |
| `.lf-chip` / `--live` / `--gold` / `--muted` / `--ok` | Status pills |
| `.lf-bar` / `--violet` / `--gold` / … | Progress bars |
| `.lf-matrix` | Horizontal-scroll data rows (prefer over dense tables when matching mock) |
| `.lf-mobile-tabs` + `.lf-segment__btn` | Mobile panel switcher |
| `.lf-range` + `.lf-range__btn` | 7d/15d/30d style toggles |

### Brand pulse

Live red dot with soft ring + `animation` (respect `prefers-reduced-motion`):

```css
width: .5rem; height: .5rem; border-radius: 999px;
background: var(--live);
box-shadow: 0 0 0 3px var(--live-soft);
```

Used in public brand marks and auth navbar (`.auth-navbar__live`).

### Live modifier

```html
<div class="lf" [class.lf--live]="isLive()" [attr.data-plan]="planTier()">
```

`.lf--live` swaps radial glow emphasis toward red when streaming.

---

## Canonical reference implementations

**Read these before inventing new patterns.**

| Surface | Path | Notes |
|---------|------|--------|
| Design origin mock | `dimasite/src/app/features/landing-mocks/grok/opencode/opencode-mock-3c.component.*` | OC3c DNA |
| Product mock dashboard | `dimasite/src/app/features/landing-mocks/dev/prod-dashboard-mock.component.*` | Full bento product shell |
| Product mock commands | `dimasite/src/app/features/landing-mocks/dev/prod-commands-mock.component.*` | Commands surface DNA |
| Dev shell | `dimasite/src/app/features/landing-mocks/dev/dev-mock-shell.component.*` | Nav/shell reference |
| **Landing (prod)** | `dimasite/src/app/features/landing/landing-page.component.*` | Public marketing bento |
| **Tip (prod)** | `dimasite/src/app/features/tip/tip-page.component.*` | Public donation bento |
| **Dashboard (prod)** | `dimasite/src/app/features/dashboard/dashboard.component.*` | Auth page bento + real APIs |
| **Auth shell (prod)** | `dimasite/src/app/features/layout/authenticated-layout.component.*` | Full-bleed bg + LF navbar |

Preview URLs:

- `/` — landing  
- `/tip/:streamer` — tip  
- `/:streamer/dashboard` — dashboard  
- `/mocks/dev/prod-dashboard` — visual reference  
- `/mocks/grok/oc3c` — original Live First landing mock  

---

## Migration checklist (legacy → Live First)

1. Identify page owner under `dimasite/src/app/features/...`.
2. Open the closest reference implementation above.
3. Add **component-scoped** `*.component.css` with LF `:host` tokens (hybrid CSS policy).
4. Restructure template to bento/tiles — **not** only recolor old classes.
5. If authenticated: rely on `AuthenticatedLayoutComponent` for bg/nav; page content has no outer chrome padding.
6. Wire existing services/signals; keep API contracts.
7. Use real Twitch profile images via `GET /users?username=` when showing streamers (letter fallback).
8. i18n both `en` and `es`.
9. Mobile-first + `prefers-reduced-motion` for pulses/hovers.
10. `npm run build --prefix dimasite` and verify.

### Anti-patterns (do not do)

- Recolor old `.dashboard-shell` / glass cards and call it done  
- Nested full-page card inside padded `auth-layout__content`  
- Cyan/blue aurora shells, Sora-as-primary for LF pages  
- Hard-coded English in templates  
- Putting large page CSS back into global `styles.css`  
- Inventing a parallel token set (`--dash-*` only as temporary alias when inheriting into old children)

---

## Auth shell rules

`AuthenticatedLayoutComponent`:

- Owns **page background** (radial glows + `--bg`)
- Sticky **LF navbar** (live pulse, pill links, avatar menu, mobile panel)
- `auth-layout__content { padding: 0 }` — pages provide their own gutters via `.lf-main`

Page components:

- Root `.lf` is transparent / full width
- `.lf-main` = `max-width: 74rem; margin: 0 auto; padding: 1rem …`

---

## Public page rules

Landing / tip / similar:

- Page owns background + nav (or shared public nav pattern matching landing)
- Sticky nav: brand pulse · language · theme · login CTA
- Theme icon + label must be **inline-flex aligned** (no stacked icon-over-text)

---

## Data / API notes (prod)

| Need | Source |
|------|--------|
| Site metrics + live board | `SiteAnalyticsService` → `api.domdimabot.com` analytics SSE |
| Dashboard bootstrap / live / AI / chat | `DashboardApiService` |
| Twitch avatar by login | `GET {API}/users?username=` → `profile_image_url` |
| Dev mock login | `environment.development.ts` `MOCK_LOGIN_TOKEN` → `POST /auth/mock-login` (never production) |

---

## Breakpoints

```css
/* base: phone */
@media (min-width: 640px) { /* tablet row actions, denser grids */ }
@media (min-width: 960px) { /* desktop hero columns, show nav links */ }
```

Touch targets ≥ 44px. Prefer `min-width` media queries.

---

## File / CSS policy

- Prefer `feature/*.component.css` for page styles (budget: warn ~50kB / error ~100kB anyComponentStyle).
- Global `styles.css`: tokens, resets, truly shared utilities only.
- Angular: standalone, OnPush, signals, `inject()`, native control flow.

---

## Agent workflow (short)

```
1. Read this skill
2. Open closest reference component (table above)
3. Match structure + tokens, keep APIs
4. Mobile-first polish + i18n
5. Build dimasite + visual check (Playwright/localhost if available)
```

If unsure between “looks like old site with new colors” vs “true bento Live First”, **choose structure from prod-dashboard-mock / landing**, not a recolor.

---

## Related docs

- `dimasite/AGENTS.md` — Angular + styling policy (points here)
- Root `AGENTS.md` — monorepo map
- Design mock catalogue: `landing-mocks/grok/grok-mock-index.component.ts` (OC3c entry)
