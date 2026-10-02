---
name: live-first
description: Live First (OC3c) design language for dimasite production UI. Use when building, migrating, restyling, or reviewing any dimasite page/component — landing, tip, dashboard, auth shell, commands, modules, settings, or new frontend surfaces. Keywords: Live First, OC3c, bento, lf-tile, lf-bento, design system, dimasite UI, navbar, dashboard layout, module page, settings page, editor dialog, save bar, item rows.
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

1. **Bento over sections** — content in rounded tiles on a soft radial background, not glass cards in a colored shell. Landing, tip and dashboard use the hero bento; **module and settings pages use the compact module pattern below** (no hero tiles or stats boxes).
2. **Full-bleed app chrome** — authenticated pages fill the site; layout owns background. No nested “page card” with outer site padding.
3. **Proof / live first** — live state, channel identity, metrics are first-class (chips, spotlight, pulse dots).
4. **Tokens only** — `:host` LF CSS variables; no one-off hard-coded palette in templates.
5. **Mobile-first** — base 320–480px; enhance with `min-width` (640 / 960).
6. **Keep data wiring** — restyle/restructure markup; do not rewrite working services/APIs unless asked.
7. **i18n** — all user strings via `LanguageService` + `en.json` / `es.json` (toasts and aria-labels too).
8. **Answer the streamer's real question first** — in plain language ("Viewers can only buy while the overlay is open", "you'll run out in ~3 days"), not internal jargon (AST, endpoints, runtime, provider ids).

## Design tokens

Put these on the page/shell `:host` (and dark via `:host-context(html.dark)`):

| Token | Light | Dark |
|-------|-------|------|
| `--bg` | `#f4f5f8` | `#0f1115` |
| `--tile` | `#ffffff` | `#171a21` |
| `--fg` | `#14151a` | `#f5f7fb` |
| `--muted` | `#596273` | `#a7b0c2` |
| `--line` | `rgba(15,17,21,.08)` | `rgba(255,255,255,.07)` |
| `--accent` | `#7c3aed` | `#8b5cf6` (bento) / `#a78bfa` (module pages, for text on dark tiles) |
| `--accent-soft` | `rgba(124,58,237,.12)` | `rgba(139,92,246,.16)` |
| `--live` | `#ef4444` | `#ef4444` |
| `--live-soft` | `rgba(239,68,68,.12)` | `rgba(239,68,68,.14)` |
| `--ok` | `#166534` | `#86efac` |
| `--warn` | `#92400e` | `#fbbf24` |
| `--danger` | `#b91c1c` | `#fca5a5` |
| `--gold` | `#92400e` (text) / `#b45309` (decoration) | `#fbbf24` |
| `--gold-soft` | `rgba(180,83,9,.12)` | `rgba(251,191,36,.14)` |
| `--btn` | `#eef0f5` | `#1d2230` |
| `--btn-border` | `rgba(15,17,21,.1)` | `rgba(255,255,255,.07)` |
| `--kicker` / `--title-accent` | `#6d28d9` | `#c4b5fd` |
| `--radius` | `1.25rem`–`1.35rem` | same |
| `--shadow` | soft black ~8% | deeper ~35% |
| `--font` | `'Plus Jakarta Sans', 'Segoe UI', system-ui, sans-serif` | same |
| `--glow-a` | violet soft | violet soft |
| `--glow-b` | red soft | red soft |

**Contrast:** light-mode `--muted/--ok/--warn/--danger/--gold` above are the AA-safe values (axe passes on white and `--input-bg`); don't lighten them. Filled primary buttons, switches and step numbers use solid `#7c3aed` with white text in **both** themes (the lighter dark-mode accent fails contrast under white text).

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

### Module & settings pages (compact pattern)

Used by every redesigned `/:streamer/modules/*` page and the credits/usage pages. Prefer it over the hero bento for any page whose job is "configure something".

**Header (`header.lf-head`)** — back link, plain title (just the module name, never doubled like "Storefront DimaFX"), one-sentence subtitle that says what it does for the streamer, then a row of status chips (`.lf-head__chips`: on/off with `.lf-dot`, counts like "4 of 5 on sale", plan/storage, a small Refresh chip). One primary action on the right (e.g. "New item"). No stats boxes that repeat numbers the list already shows.

**Setup strip (`.lf-setup`)** — one-time setup (OBS browser-source URL, speech URL) as a single row: icon, title + live status chip, one-line hint, readonly URL input + Copy (+ Open). Turn it amber with a plain consequence ("viewers can't buy right now") when the thing it sets up is disconnected.

**Panels** — at ≥960px, `.lf-panels` is `minmax(0,1.5–1.6fr) minmax(0,1fr)`: main column (what you change) and side column (how to use it: command, cheat sheet of `$(...)` functions, credits). `.lf-col` is `display: contents` on phones so cards simply stack.

**Dense rows over identical cards** — list items are rows, not tiles:

```
[16:9 thumb] Name  [price/status chips]          [Test] [Edit] [switch] [🗑]
             type · one-line description / command
```

- Thumbs show **real previews**: `<img>` for images/GIFs, first video frame via `LazyVideoFrameDirective` (`features/triggers/lazy-video-frame.directive.ts`: loads the source near the viewport, seeks `#t=0.1`), media-type icon + tint (`--t-audio/--t-video/--t-image`) otherwise. Tap thumb = preview; audio plays inline and the icon becomes pause. Never replace real previews with icons to save space.
- Quick on/off is an `.lf-switch` in the row (optimistic update + rollback), labelled "{{name}} on".
- Destructive actions are an icon button; row actions get `aria-label`s with the item name ("Edit Airhorn").
- Search appears only once a list is long (e.g. > 6 items); type filters as `aria-pressed` chips.
- Show cross-links that answer "what's this used by?" (e.g. "In 2 triggers", or a "Use" button on unused media).

**Choice cards** — engine/kind/visibility choices are radio cards (`.lf-engine` / `.lf-choice__opt`): name + tone tag (green = cheapest/free, accent = mid, gold = premium/uses credits) + one-line copy. Grid of 2 at ≥560px, one column on phones. Upcoming options are a dashed card with a "Coming soon" chip and **no input**, so they can't be selected or saved.

**Collapsible groups** — long pill lists (e.g. 75 voice tags) go in `<details>` groups whose summary shows the count and what's off ("6/8 · Off: singing, screaming"), with "Turn all on/off" inside.

**Save bar** — pages with a draft use a sticky `.lf-save-bar` (bottom: 0.75rem) with a status line ("Unsaved changes" / "All changes saved") and exactly one primary button. Never a floating button that covers content.

### Editors and dialogs

- Create/edit is a **dialog**, not an always-open side form. Numbered steps (`.lf-step` + `.lf-step__num`): 1 what it is/does → 2 the content (media picker / message) → 3 how it appears (name, price, description, volume) → `<details>` "More options" for rare fields (category override, position, colours).
- Auto-fill from the user's choice (name follows the picked file until they type; category follows media type) and show the resulting command live (`$(trigger.send Name)`).
- Validation is inline under the field after the first submit attempt (`submitAttempted` signal), plus `aria-invalid`; toasts are for server results only.
- When the API can't change something on edit (media swap, switching kind), **lock it and say why** — never show a control the server silently ignores.
- Destructive choices with consequences get their own `role="alertdialog"` with explained options (e.g. "Delete and refund saved copies" vs "Delete without refund"), not two bare buttons.
- Dialog chrome: overlay `position: fixed; z-index ≥ 120` (above the navbar), bottom sheet on phones (`92dvh`), centred card at ≥640px, `role="dialog" aria-modal="true" aria-labelledby`, Escape closes the topmost layer only (preview → dialog), sticky footer with Cancel + one primary.

### Controls

- **Sliders**: never ship a bare native `<input type=range>` (Chrome leaves track past the thumb at 0/100%). Use `.lf-range` with `appearance: none`, a track gradient that ends at the thumb centre via `[style.--pct]="value / max"`, a styled thumb and focus ring; make sure field input styles exclude `[type='range']`.
- **Selects of ids**: show human labels (group with `<optgroup>`, e.g. Kokoro voices by language: "Spanish → Dora (female)"); keep the id as the value.
- **Prices**: Bits as a gold pill with the `bits` icon; Free as a green pill.
- `app-lf-icon` (`shared/lf-icon`) is the icon set for LF pages; add names there instead of importing ad-hoc icons.

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
| **Module page: settings + save bar** | `dimasite/src/app/features/tts/tts-page.component.*` | Choice-card engines, collapsible groups, side cheat sheet, sticky save bar |
| **Module page: rules + activity** | `dimasite/src/app/features/moderation/moderation-page.component.*` | Two-column panels, mobile tabs, pill checks, paid block |
| **Module page: list + editor dialog** | `dimasite/src/app/features/triggers/triggers-page.component.*` | Setup strip, media rows with frames, stepped editor, upload dialog |
| **Module page: shop + delete choices** | `dimasite/src/app/features/dimafx/dimafx-page.component.*` | Price pills, on-sale switches, kind choice, refund alertdialog |
| **Browse/add dialog** | `dimasite/src/app/features/triggers/components/public-library-modal.component.*` | Search + type chips + result count, inline audio, Add → next step |
| **Gallery + stage** | `dimasite/src/app/features/clips/clips-page.component.*` | One live stage + compact gallery |
| **Billing pages** | `dimasite/src/app/features/credit-packs/*`, `features/usage/*` | Plain-language forecasts, honest value cues |
| **Hub pages** | `dimasite/src/app/features/modules/*`, `features/analytics/*` | Essentials + goal groups, finder |

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
10. Preview with `scripts/saas-ops preview site --port <free port>` (find **your** preview copy via the port's process cwd, other agents run previews too), then `scripts/saas-ops build site` → `verify` → `deploy`. Never `npm run build --prefix dimasite`: it writes into the live mount.
11. Visual + behavior check with Playwright and **mocked** API/session (mutating flows must never hit production): before/after screenshots at 390 and 1280px, dark and light; axe (wcag2a/2aa/21aa) with zero violations at 320/390/1280; keep the selectors/text the existing `ops/checks/*` rely on.

### Anti-patterns (do not do)

- Recolor old `.dashboard-shell` / glass cards and call it done  
- Nested full-page card inside padded `auth-layout__content`  
- Cyan/blue aurora shells, Sora-as-primary for LF pages  
- Hard-coded English in templates  
- Putting large page CSS back into global `styles.css`  
- Inventing a parallel token set (`--dash-*` only as temporary alias when inheriting into old children)
- Doubled titles ("Twitch Extension Storefront DimaFX"), kicker + title + subtitle saying the same thing
- Stats tiles that repeat counts already visible in the list
- Floating save buttons that cover content; save buttons far from what they save
- Two unexplained destructive buttons ("Delete" / "Refund Delete") instead of one delete that explains the choice
- Raw ids or internal names in the UI (`ef_dora`, `tts.fish`, "runtime provider")
- Replacing real image/video previews with generic icons
- Native range sliders and native-looking controls next to LF pills
- Showing controls the API ignores (e.g. "Change media" on edit)

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
5. saas-ops preview → mocked Playwright check (mobile + desktop, dark + light, axe) → saas-ops build/verify/deploy
```

If unsure between “looks like old site with new colors” vs “true bento Live First”, **choose structure from prod-dashboard-mock / landing**, not a recolor.

---

## Related docs

- `dimasite/AGENTS.md` — Angular + styling policy (points here)
- Root `AGENTS.md` — monorepo map
- Design mock catalogue: `landing-mocks/grok/grok-mock-index.component.ts` (OC3c entry)
