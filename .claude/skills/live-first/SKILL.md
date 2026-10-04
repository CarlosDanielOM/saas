---
name: live-first
description: Live First (OC3c) design language and UX rules for dimasite, the admin site and the DimaFX Twitch extension viewer UI. Use when building, migrating, restyling, or reviewing any dimasite, admin or dimafx panel/mobile/config page — landing, tip, dashboard, auth shell, commands, modules, settings, admin overview/users/channel tools, or new frontend surfaces. UX first, and mobile is a first-class citizen equal to desktop. Keywords: Live First, OC3c, bento, lf-tile, lf-bento, design system, dimasite UI, admin UI, navbar, dashboard layout, module page, settings page, editor dialog, save bar, item rows, storefront, viewer shop, Twitch extension panel, DimaFX, mobile-first, UX.
---

# Live First Design Language (dimasite + admin + DimaFX extension)

**Canonical production design system for DomDimaBot’s public site, authenticated app, internal admin site (`admin/`) and the viewer-facing DimaFX Twitch extension (`dimafx/`).**

- Origin: OpenCode mock **OC3c · Live First** (`/mocks/grok/oc3c`)
- Productized: landing, tip, dashboard, authenticated layout
- Reference mocks: `/mocks/dev/prod-dashboard`, `/mocks/dev/prod-commands`

When working on **any** `dimasite/`, `admin/` or `dimafx/` client UI, follow this skill by default. Do **not** invent a new visual language or revert to aurora/glassmorphic cyan shells.

## The two non-negotiables

**1. UX first.** Every page exists to answer one question for the person using it ("Is my bot working?", "Will I run out of credits?", "Does this streamer need help?"). Before touching markup, write that question down, then design so the answer is the first thing on screen, in plain words, with the next action right next to it. Looks come second: a beautiful page that hides the answer or the next step is a failed redesign. Concretely:

- Lead with a plain-language status line, not raw numbers ("2 Twitch events are missing — the bot won't see follows"), and put the fix button beside it.
- Group by the user's goal, not by the data model or API shape.
- Every real-world side effect (sends an email, grants credits, spends money, changes a live subscription) gets an explicit confirmation that says exactly what will happen, to whom, and how much. One tap must never do something irreversible. For a single in-app purchase, a two-tap button is enough (see "Viewer storefronts"); bigger or multi-part effects get a dialog.
- Show loading, empty and error states on purpose: what happened, whether data is stale, and one Retry. Keep the user's input (search, filters, drafts) through errors.
- Keep advanced features, but tuck rare ones behind well-labelled `<details>`; never remove a capability to make a page look simpler.

**2. Mobile is a first-class citizen, equal to desktop.** A phone layout is not a squeezed desktop and not an afterthought: many users (and the owner) run the product from a phone. Design the 320–480px layout first, then give desktop its own deliberate layout; neither is allowed to be the "lesser" version.

- Every feature and action available on desktop must be reachable on a phone (no hover-only controls, no desktop-only tables without a phone row layout).
- Put primary navigation and primary actions in thumb reach on phones (bottom tab bar, sticky bottom save/confirm bars, bottom-sheet dialogs at `92dvh`), touch targets ≥ 44px, inputs ≥ 16px font (no iOS zoom).
- Phones get *more* affordances where touch is harder (chip strips instead of tiny selects, tap-to-select, move pads), not fewer.
- Pages should get much shorter on phones: dense rows, collapsible secondary info, no stacked identical cards.
- Verify both every time: screenshots at 320/390 and 1280px, light and dark, plus a no-horizontal-overflow check. A change is not done until the phone layout has been looked at.

## Business goals: what each surface should grow

Good UX here also has to earn money. Every surface has a revenue job alongside the user's question; design for both, and never trade honesty for a short-term sale (see "Honest selling" below).

| Surface | Who it serves | What it should grow |
|---------|---------------|---------------------|
| Viewer surfaces: DimaFX extension, tip page, future viewer shops | Viewers | **Bits spent on the streamer's channel.** DomDimaBot automatically keeps 20% of DimaFX Bits revenue, so every extra Bits purchase also earns us money. |
| Streamer surfaces: dimasite dashboard, modules, settings | Streamers | **(a) Upgrades to Premium/Pro tiers** and **(b) use of credit-consuming features** (premium TTS voices, AI, etc.) that lead to **credit pack purchases**. |
| Admin site | Operator (us) | Spotting streamers who are about to run out of credits, hitting plan limits, or stuck in setup, so we can help them (and keep them paying). |

**Viewer surfaces: more Bits, more often**
- Make the first purchase easy: price on every tile, buy from the grid, a cheap or free item visible near the top, no account or setup steps before paying.
- Make buying feel worth it: real previews (video motion, sound playback), the channel name, and "plays for everyone right away".
- Bring people back: the Saved tab, "N saved" tags, credits that stay on the channel, a clear "On its way!" right after paying.
- Never let a viewer get charged for something that can't play (overlay-offline gating). One bad purchase costs more future Bits than it earns.
- The streamer's DimaFX module on dimasite should help them sell: is the overlay connected, which items sell, how many Bits came in, and what's missing to sell more (e.g. no cheap item, no voice item).

**Streamer surfaces: upgrades and credit packs**
- **Show paid features where they'd help, don't hide them.** On a free plan, Premium/Pro options appear in context (choice card or row with the gold plan-tier treatment, a one-line benefit in the streamer's terms, and an "Upgrade" action beside it), not only on a pricing page.
- **Credit-powered options are first-class choices**, shown next to the free option as choice cards with a gold "uses credits" tag and the real cost per use ("~2 credits per message"). Let the streamer try them, not just read about them.
- **Pair every credit balance with a forecast and a way to top up:** "~3 days left at this rate" plus "Buy credits" right there, never a bare number on a separate page.
- **Upsell at moments of success or need:** after something worked ("your alerts played 40 times this week"), when a limit is near, or on an empty state ("Add an AI voice: viewers tip more when it speaks"). Not on every screen.
- **Admin:** list streamers who are near their credit runway or plan limits, or have half-finished setup, as actionable rows.

**Honest selling (non-negotiable)**
- Every value claim is computed from real data (bonus %, per-$ rates, "best value"); no fake "most popular", scarcity, countdowns or invented discounts.
- At most one upsell block per screen; never cover or block a free core feature with a nag. Paid prompts can be dismissed or tucked away, and stay away once dismissed.
- No dark patterns: no pre-selected paid options, no confirmshaming ("No thanks, I hate growth"), no hidden free option, and every charge goes through the explicit confirmation rules above.

## When to use

- New pages/components in `dimasite/`
- Migrating legacy pages to production design
- Navbar / shell / layout work
- Dashboard, commands, modules, settings, tip, landing, login polish
- DimaFX extension panel, mobile view and streamer config page (`dimafx/*.html`)
- Mentions of “Live First”, “bento”, “OC3c”, or “match the new design”

## Core principles

1. **Bento over sections** — content in rounded tiles on a soft radial background, not glass cards in a colored shell. Landing, tip and dashboard use the hero bento; **module and settings pages use the compact module pattern below** (no hero tiles or stats boxes).
2. **Full-bleed app chrome** — authenticated pages fill the site; layout owns background. No nested “page card” with outer site padding.
3. **Proof / live first** — live state, channel identity, metrics are first-class (chips, spotlight, pulse dots).
4. **Tokens only** — `:host` LF CSS variables; no one-off hard-coded palette in templates.
5. **Mobile-first, mobile-equal** — base 320–480px; enhance with `min-width` (640 / 960). See "The two non-negotiables" above.
6. **Keep data wiring** — restyle/restructure markup; do not rewrite working services/APIs unless asked.
7. **i18n** — all user strings via `LanguageService` + `en.json` / `es.json` (toasts and aria-labels too).
8. **Answer the user's real question first, and serve the surface's business goal** (see "Business goals": Bits on viewer surfaces, tier upgrades and credit packs on streamer surfaces). Use the user's own words (streamer on dimasite, operator on admin, viewer on the extension) — in plain language ("Viewers can only buy while the overlay is open", "you'll run out in ~3 days"), not internal jargon (AST, endpoints, runtime, provider ids).

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

**Contrast:** light-mode `--muted/--ok/--warn/--danger/--gold` above are the AA-safe values (axe passes on white and `--input-bg`); don't lighten them. Filled primary buttons, switches and step numbers use solid `#7c3aed` with white text in **both** themes (the lighter dark-mode accent fails contrast under white text). White text on `--live` (`#ef4444`) fails AA at small sizes: filled badges, tags and counters with white text use `#dc2626`; keep `--live` for the pulse dot and soft washes.

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

**Dense rows over identical cards** — when the user *manages* a list, items are rows, not tiles (when they *browse and buy*, use the tile grid in "Viewer storefronts"):

```
[16:9 thumb] Name  [price/status chips]          [Test] [Edit] [switch] [🗑]
             type · one-line description / command
```

- Thumbs show **real previews**: `<img>` for images/GIFs, first video frame via `LazyVideoFrameDirective` (`features/triggers/lazy-video-frame.directive.ts`: loads the source near the viewport, seeks `#t=0.1`), media-type icon + tint (`--t-audio/--t-video/--t-image`) otherwise. Tap thumb = preview; audio plays inline and the icon becomes pause. Never replace real previews with icons to save space. Only use a URL as `<img src>` when the media is visual (image/GIF or a generated thumbnail): an audio file's playback URL renders as a broken image, so audio falls back to the tinted tile with a waveform/icon.
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
- **Segmented choices** (`.lf-seg`, two-option toggles): the selected option is a solid `#7c3aed` fill with white text. A "lighter card on a grey track" selected state is nearly invisible in dark mode.
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
| **Viewer storefront (Twitch extension)** | `dimafx/panel.html`, `dimafx/panel.js`, `dimafx/storefront.css` | Tile grid, price pills, credits two-tap, Twitch theme/language |
| **Billing pages** | `dimasite/src/app/features/credit-packs/*`, `features/usage/*` | Plain-language forecasts, honest value cues |
| **Hub pages** | `dimasite/src/app/features/modules/*`, `features/analytics/*` | Essentials + goal groups, finder |

Preview URLs:

- `/` — landing  
- `/tip/:streamer` — tip  
- `/:streamer/dashboard` — dashboard  
- `/mocks/dev/prod-dashboard` — visual reference  
- `/mocks/grok/oc3c` — original Live First landing mock  

---

## Viewer storefronts (selling surfaces)

Pages where **viewers** spend Bits or credits (DimaFX panel, tip page, any future shop) answer a different question from streamer pages: *"What can I make happen, and how much does it cost?"* They should make buying easy and attractive while staying honest; the goal is a viewer who buys again, not one who feels tricked.

- **Lead with what's possible right now:** channel name in the title ("Play something on **Dima**'s stream"), a live/paused chip, and when buying is blocked, the consequence in plain words ("Purchases are paused, you won't be charged") before any grid.
- **Browse = tile grid, manage = rows.** Shop tiles: real preview on top (image/GIF, video first frame with muted hover motion for mouse users, waveform tile for audio, speech-bubble quote for voice items), name (2-line clamp), then a full-width price button. 2 columns on the 318px panel and phones, 3 at ≥480px, 4 at ≥640px.
- **Price buttons say the price, not "Buy":** gold Bits pill with the gem icon, green "Free", violet credits. The detail sheet's main button says the action + price ("Play now · 150 Bits").
- **Put a consequence line right under the pay button** ("Plays on Dima's stream for everyone as soon as you pay" / "Goes to your Saved tab").
- **Honest cues only:** "New" from a real `createdAt` window, "2 saved" from the viewer's inventory, refund/trust lines only when the backend guarantees them (DimaFX refunds failed plays as credits only for viewers who shared their Twitch ID, so the line is conditional). Never fake popularity, scarcity ("only 2 left"), countdowns or invented discounts.
- **Spending confirmation without friction:** Twitch shows its own confirmation for Bits, so a Bits button may start checkout directly. Credits or other in-app balances need a **two-tap button**: the first tap turns it into "Spend 50?" (solid accent, focused, resets after ~4s), the second pays. Free items may play on one tap.
- **Explain what an opt-in unlocks** at the point it's needed ("Share your Twitch ID to save items, use credits and get refunds as credits") with a button that triggers it, instead of a bare disabled control.
- **Hide filters and search the store doesn't need:** type chips with counts only when there are 2+ types; search only for long stores (> 8 items).

## Twitch extension (`dimafx/`)

The viewer extension uses the same language, adapted to Twitch:

- **Stack:** plain HTML/JS (no Angular, no `LanguageService`). `panel.html` and `mobile.html` share one markup and `panel.js`; `body.fx--mobile` widens the layout. Tokens and styles live in `dimafx/storefront.css` (on `:root` / `html.dark`, not `:host`); `config.html` (streamer setup) reuses it.
- **Size:** design for the **318×500 Twitch panel** first (compact header, scrollable middle, bottom tab bar, bottom-sheet detail), then the full-width phone view. Every check runs at 318, 320 and 390.
- **Theme and language come from Twitch:** `Twitch.ext.onContext` → toggle `html.dark` (no theme switcher of our own); English/Spanish from the `?language=` query Twitch adds, via the `STRINGS` table in `panel.js`.
- **Purchase safety is part of the design:** buttons are disabled while the overlay is offline, and every purchase re-checks the overlay before calling Twitch. Keep both when restyling.
- **Publishing:** files are served straight from the checkout, so prepare in a separate worktree and publish per `dimafx/AGENTS.md`. Behaviour check: `ops/checks/dimafx-client.mjs` (mocked Twitch + API; filters, credits two-tap, custom voice message, saved items, Spanish/no-ID, axe + overflow in dark and light).

## Admin site (`admin/`)

Same language, same tokens, same two non-negotiables. The admin is internal and English-only, but it is used from a phone as much as from a desk.

- **Tokens + shared pieces live in `admin/src/styles.css`** (the admin is small and every page shares them): `.lf-main`, `.lf-head`, `.lf-tile`, `.lf-status` (plain-language answer with tone `--ok/--warn/--live/--muted`), `.lf-chip`, `.lf-btn`, `.lf-row(s)`, `.lf-switch`, `.lf-input`, `.lf-seg`, `.lf-choice`, `.lf-step`, `.lf-more`, `.lf-dl`, `.lf-bar`, `.lf-metrics`, `dialog.lf-dialog`. Page-only layout goes in the page's component CSS.
- **Theme:** `ThemeService` (`admin/src/app/services/theme.service.ts`) — mode `system|light|dark` (default dark) + accent `violet|green|blue|cyan` on `html.dark` / `data-accent`. Accent tokens are AA-checked per mode; live/warn/plan colours never follow the accent.
- **Shell:** sticky top bar (brand pulse, pill links ≥960px, sun/moon toggle, account menu) + phone bottom tab bar (`.bottom-nav`). Content has no outer padding; pages own their gutters via `.lf-main`.
- **Answer the operator's question first:** Overview = "does anyone need me?" (attention rows link to Users pre-sorted), Users = find + status chips that double as sort shortcuts, Channel = health line listing what's wrong and the fix, Twitch events = "is the bot hearing everything?" with problems grouped first, Usage = "will they run out, and when?".
- **Real side effects always confirm:** reminder emails, AI credit grants (amount → reason → "balance goes from X to Y" → confirm), EventSub test events (warn that alerts can really appear on stream). Validation inline; toasts only for server results.
- **Raw ids are secondary:** show the plain name first ("Follows") and the raw value small/monospace (`channel.follow v2`, channel ID with a copy button).
- **State in the URL:** list pages keep search/sort/page in query params so links and Back restore the view.
- `app-avatar` (`shared/avatar`) shows real Twitch images (cached `GET /users?username=`) with letter fallback; pass `[fetch]="false"` in long lists.
- Admin is zoneless; checks must poll after clicks. Behaviour check: `ops/checks/admin-ui.mjs` (all APIs mocked, axe + overflow at 320/390/768/1280 in dark and light). Preview/build/deploy with `scripts/saas-ops preview|build admin`.

| Admin surface | Path |
|---------------|------|
| Tokens + shared primitives | `admin/src/styles.css` |
| Shell | `admin/src/app/shared/navbar/*`, `features/layout/*` |
| Overview (status + attention + live) | `admin/src/app/pages/dashboard/*` |
| Directory with chip shortcuts + URL state | `admin/src/app/pages/users/*` |
| Detail page: health line, credits, confirmed grant dialog | `admin/src/app/pages/channel/channel-detail.component.*` |
| Grouped toggles + test dialog | `admin/src/app/pages/channel/channel-eventsubs.component.*`, `shared/test-event-modal/*` |
| Forecast + chart + ledger | `admin/src/app/pages/channel/channel-usage.component.*` |
| Stepped form with choice cards | `admin/src/app/pages/email-test/*` |

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
- Fake urgency or popularity on viewer shops ("only 2 left", "trending" without data, invented discounts)
- One-tap spending of credits or other in-app balances
- Audio/video playback URLs used as `<img>` thumbnails (broken images)

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
- `admin/AGENTS.md` — admin site (points here)
- `dimafx/AGENTS.md` — Twitch extension publishing + viewer UX rules
- Root `AGENTS.md` — monorepo map
- Design mock catalogue: `landing-mocks/grok/grok-mock-index.component.ts` (OC3c entry)
