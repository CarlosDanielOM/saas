# Rebuild dimasite From olddimasite (Angular v21 + Tailwind v4)

## TL;DR
> **Summary**: Reconstruct the full DomDimaBot website in `dimasite/` using `olddimasite/` build artifacts as the source of truth for routes, UI, tokens, i18n, and flows; keep styling global-only and Tailwind v4-first.
> **Deliverables**:
> - Route/page parity with old router (public + authenticated)
> - Legacy design tokens + classnames implemented in `dimasite/src/styles.css`
> - Working auth/session, theme (`data-theme`), language (EN/ES), plan-tier styling (`data-plan-tier`)
> - Backend alignment fixes for missing endpoints/mounts required by the UI
> **Effort**: XL
> **Parallel**: YES - 5 waves
> **Critical Path**: Core plumbing → Router/layout/guards → Feature pages → QA/axe/playwright → Backend endpoint parity

## Context
### Original Request
- Rebuild the website into `dimasite/` using `olddimasite/` and `olddimasite/dist/browser` as reference; preserve design language.
- Styling rules: Tailwind v4 preferred; if Tailwind can't do it, CSS must live only in `dimasite/src/styles.css` (no component styles).
- Reference prod site: https://domdimabot.com

### Interview Summary (decisions applied)
- Implement full route parity from `olddimasite/src/main-recovered.js`.
- Pixel-close styling: reuse legacy classnames + CSS variables/tokens.
- Preserve storage keys for backward compatibility:
  - Session: `sessionStorage['user']`
  - Theme: `localStorage['theme']` (light|dark|system)
  - Language: `localStorage['userLanguage']` (en|es)
- Fix backend gaps required by the old UI:
  - Mount `/analytics` router (exists but unmounted).
  - Add `/config/site/analytics` + `/config/site/analytics/stream` (SSE) endpoints expected by landing.
- PostHog: default to a no-op wrapper service; do not add PostHog dependency unless explicitly requested later.

### Metis Review (gaps addressed)
- Explicitly froze router/guards/session storage keys as contracts.
- Added explicit decision for landing analytics contract (implement backend endpoints).
- Added guardrails against dynamic Tailwind class generation and component CSS.
- Added automated acceptance checks for: build, no component CSS, i18n key parity, required backend endpoints, key e2e flows.

## Work Objectives
### Core Objective
- Restore the full DomDimaBot web UI in `dimasite/` with the same routes, UX flows, and design language as the recovered `olddimasite/` build.

### Deliverables
- Angular v21 app with router tree matching the old `ie` route array.
- Shared core services (session/auth, theme, language, API client, toast system) rebuilt with signals.
- All feature pages rebuilt (lazy where appropriate) and wired to existing backend endpoints.
- Global-only styling in `dimasite/src/styles.css` matching legacy tokens and classnames.
- Automated verification: unit tests for core services/guards + Playwright/axe flows.

### Definition of Done (agent-verifiable)
- `cd dimasite && npm run build` succeeds.
- No non-empty component stylesheet files exist (policy compliance).
- All key routes render without console errors; protected routes redirect when unauthenticated.
- Theme toggle updates `<html data-theme="light|dark">` and persists.
- Language toggle switches a known navbar label and persists.
- Authenticated navigation sets `<html data-plan-tier="free|premium|pro">` based on backend user plan tier.
- Backend endpoints required for landing analytics and follow ledger analytics are reachable.

### Must Have
- Route parity for these paths (from `olddimasite/src/main-recovered.js`):
  - `/` landing
  - `/login`
  - `/commands/:streamer` (public)
  - `/r/:code` referral capture
  - `/:streamer/*` authenticated layout with children:
    - `dashboard`, `commands`, `modules`, `modules/clips`, `modules/chat-events`, `modules/triggers`, `modules/redemptions`, `modules/:moduleId`
    - `analytics` redirect to `analytics/follows`, plus `analytics/follows`
    - `settings`, `settings/bot-personality`, `settings/memory`
    - `admin`, `admin/users`
    - `profile/settings`
    - `logout`
- Global-only CSS (no component styles).

### Must NOT Have (guardrails)
- No new redesign; do not invent new UI patterns or color systems.
- No `ngClass`/`ngStyle`; no arrow functions in templates.
- No runtime-generated Tailwind utility strings (Tailwind must see all used classes at build time).
- No adding CSS to `*.component.css` (keep empty or remove `styleUrl`).
- No backend behavioral changes beyond the endpoints/mounts strictly required for parity.

## Verification Strategy
> ZERO HUMAN INTERVENTION — all verification is agent-executed.
- Test decision: tests-after (unit tests for core + minimal page smoke) + Playwright/axe for e2e.
- Evidence: each task stores proof in `.sisyphus/evidence/task-{N}-{slug}.*`.

## Execution Strategy
### Parallel Execution Waves
Wave 1: Core scaffolding + global styling tokens + assets
Wave 2: Router tree + guards + session/i18n/theme + shells (landing/auth layout/login)
Wave 3: Core feature pages (dashboard, commands, modules catalog, settings shell, profile settings, logout)
Wave 4: Remaining feature pages (clips, chat events, triggers, redemptions, follow ledger, bot personality, memory mgmt, admin hub/users, module stub)
Wave 5: Backend parity fixes + full e2e/axe sweep + hardening

### Dependency Matrix (high-level)
- Core services/styles (1-6) block all feature pages.
- Router/guards/layout (7-10) block all authenticated feature pages.
- Backend parity (B1-B3) blocks landing analytics + follow ledger.

## TODOs
> Implementation + Test = ONE task. Never separate.

- [ ] 1. Create route parity manifest and folder skeleton in `dimasite/src/app/`

  **What to do**: Define target folders (`core/`, `shared/`, `features/`) and a single source-of-truth `route-manifest.ts` mapping each legacy route → title → auth level → owning feature folder.
  **Must NOT do**: Do not implement page UI yet.

  **Recommended Agent Profile**:
  - Category: `unspecified-high` — Reason: repo-wide structure and routing implications.
  - Skills: []

  **Parallelization**: Can Parallel: YES | Wave 1 | Blocks: 7-20 | Blocked By: none

  **References**:
  - Pattern: `olddimasite/src/main-recovered.js` — search token `var ie = [` for routes.
  - Current scaffold: `dimasite/src/app/app.routes.ts`

  **Acceptance Criteria**:
  - [ ] `dimasite/src/app/route-manifest.ts` exists and lists every route path from the legacy router.
  - [ ] Each manifest entry includes: `path`, `title`, `auth` (public|authenticated), `feature`.

  **QA Scenarios**:
  ```
  Scenario: Manifest completeness
    Tool: Bash
    Steps: Run a script that compares manifest paths to extracted paths from `olddimasite/src/main-recovered.js`.
    Expected: No missing/extra paths.
    Evidence: .sisyphus/evidence/task-1-route-manifest.txt

  Scenario: No premature UI implementation
    Tool: Bash
    Steps: Verify only new manifest + empty folders created.
    Expected: No new components/pages yet.
    Evidence: .sisyphus/evidence/task-1-no-ui-yet.txt
  ```

  **Commit**: YES | Message: `chore(dimasite): add route manifest and feature skeleton` | Files: `dimasite/src/app/**`

- [ ] 2. Recreate legacy design tokens, theme overrides, and global base rules in `dimasite/src/styles.css`

  **What to do**: Port token blocks (`:root`, `[data-theme=dark]`) + focus/scrollbar/base typography rules; keep Tailwind v4 pipeline; add `@layer base` + `@layer components` sections.
  **Must NOT do**: Do not put CSS in component styles.

  **Recommended Agent Profile**:
  - Category: `visual-engineering` — Reason: CSS tokens + parity with legacy design.
  - Skills: [`frontend-ui-ux`] — match existing design language.

  **Parallelization**: Can Parallel: YES | Wave 1 | Blocks: all UI tasks | Blocked By: none

  **References**:
  - Tokens: `olddimasite/dist/browser/styles-B6DASTEJ.css` — `:root{--color-*}` and `[data-theme=dark]{...}`.
  - Current: `dimasite/src/styles.css`

  **Acceptance Criteria**:
  - [ ] `dimasite/src/styles.css` contains the exact token names from legacy CSS.
  - [ ] Theme switch via `<html data-theme="dark">` changes token values.

  **QA Scenarios**:
  ```
  Scenario: Theme tokens apply
    Tool: Playwright
    Steps: Load `/`, set documentElement `data-theme=dark`, verify computed `--color-surface` changes.
    Expected: Light/dark surfaces differ.
    Evidence: .sisyphus/evidence/task-2-theme-tokens.png
  
  Scenario: Focus ring visible
    Tool: Playwright
    Steps: Tab to first button on `/`.
    Expected: Visible outline meets contrast.
    Evidence: .sisyphus/evidence/task-2-focus-ring.png
  ```

  **Commit**: YES | Message: `style(dimasite): port legacy design tokens to global styles` | Files: `dimasite/src/styles.css`

- [ ] 3. Port legacy BEM class rules (selectors) into global CSS (no component styles)

  **What to do**: Extract and port all app-specific selectors (landing/auth/dashboard/commands/modules/settings/admin/profile/toast/dropdown/bot/clips/chat-events/triggers/redemptions/pricing/hero/etc.) from `styles-B6DASTEJ.css` into `dimasite/src/styles.css` under `@layer components`.
  **Must NOT do**: Do not paste Tailwind’s entire generated utilities; keep Tailwind import as the utility source.

  **Recommended Agent Profile**:
  - Category: `visual-engineering` — Reason: large CSS port requiring careful parity.
  - Skills: []

  **Parallelization**: Can Parallel: YES | Wave 1 | Blocks: page parity | Blocked By: 2

  **References**:
  - Legacy selectors: `olddimasite/dist/browser/styles-B6DASTEJ.css`
  - Class inventory: produced by parsing legacy CSS (segments include `pricing-*`, `commands-*`, `triggers-*`, `chat-*`, etc.).

  **Acceptance Criteria**:
  - [ ] Key selectors exist in `dimasite/src/styles.css`: `.landing-header`, `.auth-navbar`, `.toast-layer`, `.pricing-comparison`, `.commands-table`.

  **QA Scenarios**:
  ```
  Scenario: CSS selectors present
    Tool: Bash
    Steps: Grep `dimasite/src/styles.css` for a list of required selectors.
    Expected: All selectors found.
    Evidence: .sisyphus/evidence/task-3-css-selector-grep.txt

  Scenario: Landing header sticky
    Tool: Playwright
    Steps: Scroll landing page.
    Expected: Header remains sticky with blur backdrop.
    Evidence: .sisyphus/evidence/task-3-sticky-header.mp4
  ```

  **Commit**: YES | Message: `style(dimasite): port legacy component class rules` | Files: `dimasite/src/styles.css`

- [ ] 4. Update `dimasite/src/index.html` and public assets (title/meta/favicons) to match legacy

  **What to do**: Set `<title>` and `<meta name="description">`, add `favicon.svg`, ensure favicon links match legacy.
  **Must NOT do**: No tracking scripts.

  **Recommended Agent Profile**:
  - Category: `quick` — Reason: small HTML/assets updates.
  - Skills: []

  **Parallelization**: Can Parallel: YES | Wave 1 | Blocks: none | Blocked By: none

  **References**:
  - Legacy: `olddimasite/dist/browser/index.html`
  - Current: `dimasite/src/index.html`, `dimasite/public/`

  **Acceptance Criteria**:
  - [ ] `dimasite/src/index.html` title is `DomDimaBot - Your Ultimate Twitch Chat Companion`.
  - [ ] `dimasite/public/favicon.svg` exists.

  **QA Scenarios**:
  ```
  Scenario: Correct title
    Tool: Playwright
    Steps: Load `/` and assert page title.
    Expected: Matches legacy title.
    Evidence: .sisyphus/evidence/task-4-title.txt
  ```

  **Commit**: YES | Message: `chore(dimasite): align index metadata and favicons` | Files: `dimasite/src/index.html`, `dimasite/public/**`

- [ ] 5. Implement core services: SessionAuth, Theme, Language, ApiBase, ApiClient (signals)

  **What to do**:
  - SessionAuthService: read/write `sessionStorage['user']`, provide `getAuthHeaders()` matching legacy (supports raw and Bearer).
  - ThemeService: storage key `theme`, apply `<html data-theme>` exactly like `chunk-34KGRRI2.js`.
  - LanguageService: storage key `userLanguage`, implement dot-notation translation and `{{param}}` interpolation like legacy.
  - JSON loading decision: enable `resolveJsonModule` in `dimasite/tsconfig.json` and import `dimasite/src/assets/i18n/en.json` + `dimasite/src/assets/i18n/es.json` directly (no runtime HTTP fetch).
  - Api base: `localhost` → `http://localhost:3000`, else `https://api.domdimabot.com`.
  - ApiClient: typed envelope `{ error, message, status, data }`.
  - Wire `provideHttpClient()` in `dimasite/src/app/app.config.ts`.

  **Must NOT do**: Do not introduce `@ngx-translate/*`.

  **Recommended Agent Profile**:
  - Category: `unspecified-high` — Reason: cross-cutting core services.
  - Skills: []

  **Parallelization**: Can Parallel: YES | Wave 2 | Blocks: 6-20 | Blocked By: 1

  **References**:
  - Session key + Bearer header behavior: `olddimasite/dist/browser/chunk-7PGU4VLG.js`
  - Theme storage key + behavior: `olddimasite/dist/browser/chunk-34KGRRI2.js`
  - Language storage key + translate logic: `olddimasite/dist/browser/chunk-VH5KQ6JD.js`
  - Current app config: `dimasite/src/app/app.config.ts`

  **Acceptance Criteria**:
  - [ ] Unit tests cover: theme init, language init, session parse.
  - [ ] Toggling theme updates `<html data-theme>`.
  - [ ] Translating `navbar.dashboard` returns correct EN/ES strings.

  **QA Scenarios**:
  ```
  Scenario: Theme persistence
    Tool: Playwright
    Steps: Toggle theme to dark, reload page.
    Expected: `<html data-theme="dark">` persists.
    Evidence: .sisyphus/evidence/task-5-theme-persist.png

  Scenario: Language persistence
    Tool: Playwright
    Steps: Toggle language to ES, reload.
    Expected: A known label changes and persists.
    Evidence: .sisyphus/evidence/task-5-language-persist.png
  ```

  **Commit**: YES | Message: `feat(dimasite): add core session theme language api services` | Files: `dimasite/src/app/**`

- [ ] 6. Add translation dictionaries (EN/ES) and enforce key parity check

  **What to do**:
  - Copy legacy JSON from `olddimasite/dist/browser/assets/i18n/{en,es}.json` to:
    - `dimasite/src/assets/i18n/en.json`
    - `dimasite/src/assets/i18n/es.json`
  - Update `dimasite/angular.json` assets list to include `src/assets` (keep `public/` assets too).
  - Add a parity-check script/test that fails if EN/ES key sets diverge.
  **Must NOT do**: Do not change existing keys/copy.

  **Recommended Agent Profile**:
  - Category: `writing` — Reason: large copy artifacts; precision required.
  - Skills: []

  **Parallelization**: Can Parallel: YES | Wave 2 | Blocks: all pages | Blocked By: 5

  **References**:
  - Legacy: `olddimasite/dist/browser/assets/i18n/en.json`, `olddimasite/dist/browser/assets/i18n/es.json`

  **Acceptance Criteria**:
  - [ ] Both JSON files exist in new tree and contain identical key sets.

  **QA Scenarios**:
  ```
  Scenario: Key parity
    Tool: Bash
    Steps: Run node script to compare flattened keys.
    Expected: No mismatch.
    Evidence: .sisyphus/evidence/task-6-i18n-parity.txt
  ```

  **Commit**: YES | Message: `chore(dimasite): restore en/es translations from legacy build` | Files: `dimasite/src/**`

- [ ] 7. Rebuild router tree with lazy routes, guards, and titles

  **What to do**: Implement `Routes` matching the legacy array, including redirects (`analytics` → `analytics/follows`, `''` child → `dashboard`, `**` → landing).
  - Public: landing, login, referral capture, public commands.
  - Auth layout at `/:streamer` guarded by session validation.
  - Child routes guarded by streamer+access resolution.
  - Set `title` on routes to match legacy.

  **Recommended Agent Profile**:
  - Category: `unspecified-high` — Reason: routing + guard correctness critical.
  - Skills: []

  **Parallelization**: Can Parallel: YES | Wave 2 | Blocks: 8-20 | Blocked By: 5

  **References**:
  - Legacy router: `olddimasite/src/main-recovered.js` — `var ie = [`.
  - Current: `dimasite/src/app/app.routes.ts`

  **Acceptance Criteria**:
  - [ ] Navigating to an unknown path redirects to landing.
  - [ ] `/some-streamer/dashboard` redirects to `/login` when unauthenticated.

  **QA Scenarios**:
  ```
  Scenario: Protected redirect
    Tool: Playwright
    Steps: Visit `/:streamer/dashboard` with no session.
    Expected: URL becomes `/login`.
    Evidence: .sisyphus/evidence/task-7-protected-redirect.png
  ```

  **Commit**: YES | Message: `feat(dimasite): implement legacy router tree and guards` | Files: `dimasite/src/app/app.routes.ts`, `dimasite/src/app/**`

- [ ] 8. Implement shared Toast system + viewport component (legacy classes)

  **What to do**: Create `ToastService` (signal list) + `ToastViewportComponent` rendered at root (`App` template) matching legacy behaviors (dismiss, actions, stacking positions).
  **Must NOT do**: No third-party toast library.

  **Recommended Agent Profile**:
  - Category: `unspecified-high` — Reason: shared state + accessibility.
  - Skills: []

  **Parallelization**: Can Parallel: YES | Wave 2 | Blocks: pages needing feedback | Blocked By: 3,5

  **References**:
  - Legacy toast template logic: `olddimasite/src/main-recovered.js` — search `toast__action` / `toast-layer`.
  - Legacy CSS: `olddimasite/dist/browser/styles-B6DASTEJ.css` — `.toast-*` selectors.

  **Acceptance Criteria**:
  - [ ] Toasts are announced (aria-live) and dismissable via keyboard.

  **QA Scenarios**:
  ```
  Scenario: Toast announce + dismiss
    Tool: Playwright
    Steps: Trigger a toast from a dev button, press Escape/dismiss.
    Expected: Toast disappears; no focus trap.
    Evidence: .sisyphus/evidence/task-8-toast.mp4
  ```

  **Commit**: YES | Message: `feat(dimasite): add toast service and viewport` | Files: `dimasite/src/app/**`, `dimasite/src/styles.css`

- [ ] 9. Build Landing page (UI + live analytics) with legacy sections and actions

  **What to do**: Recreate landing structure (header, hero, features, pricing comparison, live analytics grid, live channels board, footer) using legacy classnames and i18n keys.
  - Implement live analytics: fetch `GET /config/site/analytics` and subscribe to SSE `/config/site/analytics/stream` with event name `landing-stats`.
  - Implement CTA actions: login with Twitch and open Discord.

  **Recommended Agent Profile**:
  - Category: `visual-engineering` — Reason: large, style-sensitive page.
  - Skills: [`frontend-ui-ux`]

  **Parallelization**: Can Parallel: YES | Wave 2 | Blocks: none | Blocked By: 2,3,5,6,7

  **References**:
  - Legacy landing component markup: `olddimasite/src/main-recovered.js` — search `selectors: [["app-landing-page"]]`.
  - Legacy analytics service: `olddimasite/src/main-recovered.js` — class `t1` and endpoints `/config/site/analytics`.
  - Legacy CSS selectors: `olddimasite/dist/browser/styles-B6DASTEJ.css` — `.landing-*`, `.pricing-*`, `.hero-*`.

  **Acceptance Criteria**:
  - [ ] `/` renders and has working theme + language toggles.
  - [ ] If analytics endpoints 404, page still renders with a “reconnecting” state (no crash).

  **QA Scenarios**:
  ```
  Scenario: Landing renders
    Tool: Playwright
    Steps: Load `/` on mobile + desktop viewport.
    Expected: No layout overflow; header sticky; pricing table responsive.
    Evidence: .sisyphus/evidence/task-9-landing.png

  Scenario: SSE live analytics
    Tool: Bash
    Steps: Curl `/config/site/analytics` and open `/config/site/analytics/stream`.
    Expected: Snapshot JSON from GET; SSE emits `landing-stats` events.
    Evidence: .sisyphus/evidence/task-9-sse.txt
  ```

  **Commit**: YES | Message: `feat(dimasite): rebuild landing page with legacy analytics` | Files: `dimasite/src/app/features/landing/**`, `dimasite/src/styles.css`

- [ ] 10. Build Login page (Twitch implicit flow + backend login + billing return) parity

  **What to do**: Implement `/login` behavior from `chunk-PJL2FHHV.js`:
  - Extract `access_token` from URL hash.
  - Validate via `https://id.twitch.tv/oauth2/validate`.
  - Fetch user via `https://api.twitch.tv/helix/users` with `Client-Id`.
  - Twitch client id decision: default to legacy `jl9k3mi67pmrbl1bh67y07ezjdc4cf` (move to a single constant, not duplicated).
  - Redirect URI decision: `localhost` → `http://localhost:4200/login`, prod → `https://domdimabot.com/login`.
  - POST to backend `/auth/login` with `{ id, name, email, referralCode? }`.
  - Persist session as `sessionStorage['user']` with fields needed by UI.
  - Handle pending billing plan via sessionStorage keys and call `/billing/checkout` if needed.
  - Handle `?billing=success|cancel` feedback.

  **Recommended Agent Profile**:
  - Category: `unspecified-high` — Reason: auth flow correctness + security.
  - Skills: []

  **Parallelization**: Can Parallel: YES | Wave 2 | Blocks: authenticated features | Blocked By: 5,6,7

  **References**:
  - Legacy login logic: `olddimasite/dist/browser/chunk-PJL2FHHV.js`
  - Backend login: `dimabot/src/server/routes/auth.route.ts` — `POST /auth/login`.
  - Billing checkout: `dimabot/src/server/routes/billing.route.ts` — `POST /billing/checkout`.

  **Acceptance Criteria**:
  - [ ] With no token, `/login` redirects to `/`.
  - [ ] With a fake/invalid token, shows error state and redirects home after delay.
  - [ ] With a valid token, stores session and redirects to `/:login/dashboard`.

  **QA Scenarios**:
  ```
  Scenario: Invalid token
    Tool: Playwright
    Steps: Visit `/login#access_token=INVALID`.
    Expected: Error UI then redirect to `/`.
    Evidence: .sisyphus/evidence/task-10-login-invalid.mp4
  ```

  **Commit**: YES | Message: `feat(dimasite): rebuild login flow and session persistence` | Files: `dimasite/src/app/features/login/**`, `dimasite/src/app/core/**`

- [ ] 11. Remove Angular starter placeholder UI and enforce global-only styling rule

  **What to do**:
  - Replace `dimasite/src/app/app.html` with a minimal shell: toast viewport + `<router-outlet>`.
  - Remove inline `<style>` blocks from templates.
  - Remove `styleUrl` usage from `dimasite/src/app/app.ts` (or keep the referenced file empty); ensure no new component CSS is introduced.

  **Must NOT do**: Do not add any CSS files for components.

  **Recommended Agent Profile**:
  - Category: `quick` — Reason: small but policy-critical cleanup.
  - Skills: []

  **Parallelization**: Can Parallel: YES | Wave 2 | Blocks: all UI parity | Blocked By: 8

  **References**:
  - Current placeholder: `dimasite/src/app/app.html`
  - Policy: “styles only in `dimasite/src/styles.css`”

  **Acceptance Criteria**:
  - [ ] `dimasite/src/app/app.html` contains no `<style>` tags.
  - [ ] `find dimasite/src -name "*.css"` returns only `dimasite/src/styles.css` plus any empty legacy placeholders.

  **QA Scenarios**:
  ```
  Scenario: No inline styles
    Tool: Bash
    Steps: Grep for `<style>` under `dimasite/src/app`.
    Expected: No matches.
    Evidence: .sisyphus/evidence/task-11-no-inline-style.txt

  Scenario: Component CSS policy
    Tool: Bash
    Steps: Count non-empty `*.css` under `dimasite/src/app`.
    Expected: 0.
    Evidence: .sisyphus/evidence/task-11-no-component-css.txt
  ```

  **Commit**: YES | Message: `chore(dimasite): remove starter template and enforce global CSS` | Files: `dimasite/src/app/app.*`

- [ ] 12. Implement Referral Capture page (`/r/:code`) parity

  **What to do**: Implement page behavior from legacy component `c1`:
  - Read `code` param, validate via `GET /referrals/validate/:code`.
  - If valid, store `sessionStorage['referral.pendingCode']` and `sessionStorage['referral.pendingCodeAt']`.
  - Always redirect to `/` afterward.

  **Must NOT do**: Do not show a full UI; keep a minimal `aria-busy` section like legacy.

  **Recommended Agent Profile**:
  - Category: `quick` — Reason: small route with clear behavior.
  - Skills: []

  **Parallelization**: Can Parallel: YES | Wave 2 | Blocks: login (referral apply) | Blocked By: 7

  **References**:
  - Legacy: `olddimasite/src/main-recovered.js` — component `c1` near route `path: "r/:code"`.
  - Backend: `dimabot/src/server/routes/referral.route.ts` — `GET /referrals/validate/:code`.

  **Acceptance Criteria**:
  - [ ] Visiting `/r/abc` stores or clears referral pending keys and ends at `/`.

  **QA Scenarios**:
  ```
  Scenario: Invalid code clears pending
    Tool: Playwright
    Steps: Visit `/r/invalidcode`.
    Expected: Redirects to `/`; pending referral keys absent.
    Evidence: .sisyphus/evidence/task-12-referral-invalid.png
  ```

  **Commit**: YES | Message: `feat(dimasite): add referral capture route` | Files: `dimasite/src/app/features/referral/**`, `dimasite/src/app/app.routes.ts`

- [ ] 13. Add required frontend dependencies (icons, charts, sockets) matching legacy capabilities

  **What to do**:
  - Add dependencies used by legacy pages:
    - `socket.io-client` (websockets)
    - `echarts` + `ngx-echarts` (dashboard charts)
    - `lucide-angular` (icons)
  - Add thin wrappers/services so feature pages don’t import vendor APIs directly.

  **Must NOT do**: Do not add extra UI frameworks.

  **Recommended Agent Profile**:
  - Category: `unspecified-high` — Reason: dependency + wrapper choices affect many pages.
  - Skills: []

  **Parallelization**: Can Parallel: YES | Wave 2 | Blocks: dashboard + icon-heavy pages | Blocked By: none

  **References**:
  - Legacy deps: `olddimasite/package.json` — `socket.io-client`, `lucide-angular`.
  - Legacy charts: `olddimasite/src/main-recovered.js` — provider `_1({ echarts: () => import(...) })`.

  **Acceptance Criteria**:
  - [ ] `cd dimasite && npm run build` still succeeds after dependency additions.

  **QA Scenarios**:
  ```
  Scenario: Dependency smoke
    Tool: Bash
    Steps: `cd dimasite && npm run build`.
    Expected: exit 0.
    Evidence: .sisyphus/evidence/task-13-build.txt
  ```

  **Commit**: YES | Message: `chore(dimasite): add socket icons charts deps` | Files: `dimasite/package.json`, `dimasite/package-lock.json`

- [ ] 14. Implement Authenticated Layout shell (navbar/actions/dropdowns) parity

  **What to do**: Rebuild `AuthenticatedLayoutComponent` per `chunk-USZMG47D.js`:
  - Sticky `.auth-navbar` with brand link to `/${user.login}/dashboard`.
  - Nav links: dashboard/commands/modules/analytics(follows)/settings.
  - Actions: theme toggle, language dropdown, user dropdown (profile settings, logout).
  - Bot CTA states wired to `/auth/authorize?state=<login>&action=activate|reauthenticate|update`.
  - Validate session on init by calling `GET /site/` with auth headers; clear session and redirect `/login` on failure.
  - Apply `<html data-plan-tier>` from session/streamer context (effect).

  **Must NOT do**: Do not add a sidebar unless legacy layout requires it (CSS suggests navbar-first).

  **Recommended Agent Profile**:
  - Category: `visual-engineering` — Reason: UX parity + responsive menus.
  - Skills: [`frontend-ui-ux`]

  **Parallelization**: Can Parallel: YES | Wave 2 | Blocks: all authenticated pages | Blocked By: 3,5,6,7

  **References**:
  - Layout + behaviors: `olddimasite/dist/browser/chunk-USZMG47D.js` — search `selectors:[["app-authenticated-layout"]]` and `validateSession()`.
  - Backend: `dimabot/src/server/routes/auth.route.ts` — `/auth/authorize`.
  - Backend: `dimabot/src/server/routes/site.route.ts` — `GET /site/` (auth required).
  - Legacy CSS: `olddimasite/dist/browser/styles-B6DASTEJ.css` — `.auth-navbar*`, `.dropdown*`, `.bot-cta*`.

  **Acceptance Criteria**:
  - [ ] With a valid session, layout renders nav + user menu.
  - [ ] With invalid/expired session, layout clears session and redirects to `/login`.

  **QA Scenarios**:
  ```
  Scenario: Session validation failure
    Tool: Playwright
    Steps: Seed `sessionStorage['user']` with a fake token; visit `/:streamer/dashboard`.
    Expected: Redirect to `/login` and storage cleared.
    Evidence: .sisyphus/evidence/task-14-session-clear.mp4
  ```

  **Commit**: YES | Message: `feat(dimasite): rebuild authenticated layout navbar and menus` | Files: `dimasite/src/app/features/layout/**`, `dimasite/src/app/app.routes.ts`

- [ ] 15. Implement streamer resolution + access guard (legacy guard `L`) and context services

  **What to do**:
  - Implement a `StreamerContextService` (signals): current streamer profile + channelID + access role + planTier.
  - Guard behavior:
    - If no session → redirect `/login`.
    - Read `:streamer` param from current route or parent.
    - Resolve streamer via `GET /users?username=<login>`.
    - Fetch access via `GET /dashboard/:channelID/access`.
    - On success, set context + `<html data-plan-tier>`.
    - On failure, clear context and redirect `/`.

  **Must NOT do**: Do not make guards mutate the router in side effects beyond returning `UrlTree` (keep deterministic).

  **Recommended Agent Profile**:
  - Category: `unspecified-high` — Reason: auth correctness impacts entire app.
  - Skills: []

  **Parallelization**: Can Parallel: YES | Wave 2 | Blocks: 16-25 | Blocked By: 5,7,14

  **References**:
  - Legacy guard `L`: `olddimasite/src/main-recovered.js` — `var L = async i => { ... resolveStreamer ... getAccess ... }`.
  - Backend streamer lookup: `dimabot/src/server/routes/user.route.ts` — `GET /users?username=`.
  - Backend access: `dimabot/src/server/routes/dashboard.route.ts` — `GET /dashboard/:channelID/access`.

  **Acceptance Criteria**:
  - [ ] Access guard sets plan tier and streamer context for downstream pages.

  **QA Scenarios**:
  ```
  Scenario: Unknown streamer redirects home
    Tool: Playwright
    Steps: Visit `/unknown/dashboard` with valid session.
    Expected: Redirect to `/`.
    Evidence: .sisyphus/evidence/task-15-unknown-streamer.png
  ```

  **Commit**: YES | Message: `feat(dimasite): add streamer context and access guard` | Files: `dimasite/src/app/core/**`, `dimasite/src/app/app.routes.ts`

- [ ] 16. Implement public Commands page (`/commands/:streamer`) parity

  **What to do**: Rebuild the legacy public commands page (non-auth) with the legacy classnames (`public-commands*` in CSS).
  - Resolve streamer login from route.
  - Fetch streamer data via `/users?username=` and commands via `GET /commands/:channelID`.
  - Render read-only list/table; no CRUD.

  **Recommended Agent Profile**:
  - Category: `visual-engineering` — Reason: page layout + data rendering.
  - Skills: []

  **Parallelization**: Can Parallel: YES | Wave 3 | Blocks: none | Blocked By: 7,15

  **References**:
  - Route definition: `olddimasite/src/main-recovered.js` — `path: "commands/:streamer"`.
  - Backend: `dimabot/src/server/routes/command.route.ts` — `GET /commands/:channelID`.

  **Acceptance Criteria**:
  - [ ] Visiting `/commands/<streamer>` loads commands or shows empty/error state.

  **QA Scenarios**:
  ```
  Scenario: Public commands load
    Tool: Playwright
    Steps: Visit `/commands/<knownStreamer>`.
    Expected: Table/list renders without auth.
    Evidence: .sisyphus/evidence/task-16-public-commands.png
  ```

  **Commit**: YES | Message: `feat(dimasite): rebuild public commands page` | Files: `dimasite/src/app/features/public-commands/**`

- [ ] 17. Implement Dashboard page parity (bootstrap + charts + live status)

  **What to do**:
  - Fetch bootstrap data via `GET /dashboard/:channelID/bootstrap`.
  - Poll or subscribe to live status via `GET /dashboard/:channelID/live-status` and/or websocket namespace `/dashboard/:channelID`.
  - Render KPI cards and charts via `ngx-echarts` with legacy classnames (`dashboard-*`).

  **Must NOT do**: Do not implement charts with raw canvas code; use `echarts` like legacy.

  **Recommended Agent Profile**:
  - Category: `unspecified-high` — Reason: charts + data mapping.
  - Skills: []

  **Parallelization**: Can Parallel: YES | Wave 3 | Blocks: none | Blocked By: 13,14,15

  **References**:
  - Backend: `dimabot/src/server/routes/dashboard.route.ts` — bootstrap/live-status.
  - Legacy CSS: `olddimasite/dist/browser/styles-B6DASTEJ.css` — `.dashboard-*`.
  - Legacy dashboard chunk: `olddimasite/dist/browser/chunk-ZB4JWVDL.js`.

  **Acceptance Criteria**:
  - [ ] Dashboard renders KPI cards and at least one chart with non-empty series.

  **QA Scenarios**:
  ```
  Scenario: Dashboard loads
    Tool: Playwright
    Steps: Seed session; visit `/:streamer/dashboard`.
    Expected: No errors; shows dashboard title and KPI grid.
    Evidence: .sisyphus/evidence/task-17-dashboard.png
  ```

  **Commit**: YES | Message: `feat(dimasite): rebuild dashboard page with charts` | Files: `dimasite/src/app/features/dashboard/**`

- [ ] 18. Implement authenticated Commands page parity (CRUD + pagination)

  **What to do**: Rebuild `CommandsPageComponent` (authenticated): list commands, create/update/delete via backend, show toast feedback, match legacy classnames (`commands-*`).
  - Use `/commands/:channelID` endpoints with auth headers.

  **Recommended Agent Profile**:
  - Category: `unspecified-high` — Reason: CRUD forms + validation.
  - Skills: []

  **Parallelization**: Can Parallel: YES | Wave 3 | Blocks: none | Blocked By: 14,15

  **References**:
  - Backend: `dimabot/src/server/routes/command.route.ts`.
  - Legacy CSS: `olddimasite/dist/browser/styles-B6DASTEJ.css` — `.commands-*`.
  - Legacy commands chunk: `olddimasite/dist/browser/chunk-GQEVS2YI.js`.

  **Acceptance Criteria**:
  - [ ] Create + edit + delete flows succeed against backend and update UI.

  **QA Scenarios**:
  ```
  Scenario: Create command
    Tool: Playwright
    Steps: Open `/:streamer/commands`, create a command with a unique name, save.
    Expected: New row appears; toast success.
    Evidence: .sisyphus/evidence/task-18-command-create.mp4
  ```

  **Commit**: YES | Message: `feat(dimasite): rebuild authenticated commands CRUD` | Files: `dimasite/src/app/features/commands/**`

- [ ] 19. Implement Modules catalog + module stub pages parity

  **What to do**:
  - Modules catalog page lists modules and links to module routes (clips/chat-events/triggers/redemptions).
  - Module stub (`/modules/:moduleId`) renders legacy “coming soon/to be implemented” UI with i18n keys.

  **Recommended Agent Profile**:
  - Category: `visual-engineering` — Reason: layout-heavy but mostly static.
  - Skills: []

  **Parallelization**: Can Parallel: YES | Wave 3 | Blocks: 20-22 | Blocked By: 14,15

  **References**:
  - Legacy module routes: `olddimasite/src/main-recovered.js` — `path: "modules"` / `modules/:moduleId`.
  - Legacy chunks: `olddimasite/dist/browser/chunk-KNJA5C3Z.js`, `olddimasite/dist/browser/chunk-JEHNDQPE.js`.
  - Legacy CSS: `.modules-*`, `.module-*`.

  **Acceptance Criteria**:
  - [ ] Modules catalog links route correctly.

  **QA Scenarios**:
  ```
  Scenario: Modules nav
    Tool: Playwright
    Steps: Visit `/:streamer/modules`, click Clips.
    Expected: Navigates to `/:streamer/modules/clips`.
    Evidence: .sisyphus/evidence/task-19-modules-nav.mp4
  ```

  **Commit**: YES | Message: `feat(dimasite): rebuild modules catalog and stub` | Files: `dimasite/src/app/features/modules/**`

- [ ] 20. Implement Clips module page parity (designs + preview)

  **What to do**: Rebuild clips module page using legacy endpoints:
  - Load clip designs via backend (legacy uses `/clip/:channelID?design=` and `/clip/test`).
  - Preview uses an iframe or embedded view that loads `/clip/:channelID`.

  **Recommended Agent Profile**:
  - Category: `visual-engineering` — Reason: complex responsive preview UI.
  - Skills: [`frontend-ui-ux`]

  **Parallelization**: Can Parallel: YES | Wave 4 | Blocks: none | Blocked By: 14,15

  **References**:
  - Backend: `dimabot/src/server/routes/clip.route.ts`.
  - Legacy chunk: `olddimasite/dist/browser/chunk-E2I4KZQM.js`.
  - Legacy CSS: `.clips-*`, `.clip-*`.

  **Acceptance Criteria**:
  - [ ] Clips page loads and preview renders without mixed-content errors.

  **QA Scenarios**:
  ```
  Scenario: Clips preview
    Tool: Playwright
    Steps: Visit clips page, select design, wait for iframe to load.
    Expected: Clip preview visible.
    Evidence: .sisyphus/evidence/task-20-clips-preview.png
  ```

  **Commit**: YES | Message: `feat(dimasite): rebuild clips module page` | Files: `dimasite/src/app/features/clips/**`

- [ ] 21. Implement Chat Events module page parity (events + eventsubs)

  **What to do**: Rebuild chat events UI (cards, tiers, modal) and wire endpoints:
  - `GET /site/events`, `POST /site/events`, `PATCH /site/events/:id`
  - `GET/POST/PATCH/DELETE /eventsubs/:channelID` as required by legacy

  **Recommended Agent Profile**:
  - Category: `unspecified-high` — Reason: multiple endpoints + form-heavy.
  - Skills: []

  **Parallelization**: Can Parallel: YES | Wave 4 | Blocks: none | Blocked By: 14,15

  **References**:
  - Backend: `dimabot/src/server/routes/site.route.ts`, `dimabot/src/server/routes/eventsub.route.ts`.
  - Legacy chunk: `olddimasite/dist/browser/chunk-PTKUGSFF.js`.
  - Legacy CSS: `chat-*`, `chat-events-*`.

  **Acceptance Criteria**:
  - [ ] Page loads events and can update at least one event field.

  **QA Scenarios**:
  ```
  Scenario: Chat events load
    Tool: Playwright
    Steps: Visit `/:streamer/modules/chat-events`.
    Expected: Cards render; no 401.
    Evidence: .sisyphus/evidence/task-21-chat-events.png
  ```

  **Commit**: YES | Message: `feat(dimasite): rebuild chat events module page` | Files: `dimasite/src/app/features/chat-events/**`

- [ ] 22. Implement Triggers module page parity (CRUD + file upload + overlay emit)

  **What to do**: Rebuild triggers UI and wire endpoints:
  - `GET/POST/PATCH/DELETE /triggers/:channelID`
  - file list: `GET /triggers/files/:channelID`
  - upload: `POST /triggers/:channelID/upload` (multipart)
  - send: `POST /triggers/:channelID/send` and socket namespace `/overlays/triggers/:channelID` client connection.

  **Recommended Agent Profile**:
  - Category: `unspecified-high` — Reason: multipart upload + socket integration.
  - Skills: []

  **Parallelization**: Can Parallel: YES | Wave 4 | Blocks: none | Blocked By: 13,14,15

  **References**:
  - Backend: `dimabot/src/server/routes/trigger.route.ts`, websocket `/overlays/triggers/:channelID` in `dimabot/src/server/websocket.ts`.
  - Legacy chunk: `olddimasite/dist/browser/chunk-RZM6IHVF.js`.
  - Legacy CSS: `.triggers-*`.

  **Acceptance Criteria**:
  - [ ] Uploading a file succeeds and appears in file list.
  - [ ] Sending a trigger reports active connections.

  **QA Scenarios**:
  ```
  Scenario: Trigger upload
    Tool: Playwright
    Steps: Upload a small file using the triggers UI.
    Expected: Success toast; file list updates.
    Evidence: .sisyphus/evidence/task-22-trigger-upload.mp4
  ```

  **Commit**: YES | Message: `feat(dimasite): rebuild triggers module page` | Files: `dimasite/src/app/features/triggers/**`

- [ ] 23. Implement Redemptions module page parity (rewards CRUD)

  **What to do**: Rebuild redemption reward management with endpoints:
  - `GET /rewards/twitch/:channelID`
  - `GET/POST/PATCH/DELETE /rewards/:channelID`

  **Recommended Agent Profile**:
  - Category: `unspecified-high` — Reason: CRUD + mapping Twitch vs DB rewards.
  - Skills: []

  **Parallelization**: Can Parallel: YES | Wave 4 | Blocks: none | Blocked By: 14,15

  **References**:
  - Backend: `dimabot/src/server/routes/reward.route.ts`.
  - Legacy chunk: `olddimasite/dist/browser/chunk-JKVXPQTQ.js`.
  - Legacy CSS: `.redemptions-*`, `.redemption-*`.

  **Acceptance Criteria**:
  - [ ] Creating a reward record succeeds and persists after refresh.

  **QA Scenarios**:
  ```
  Scenario: Rewards list loads
    Tool: Playwright
    Steps: Visit `/:streamer/modules/redemptions`.
    Expected: Twitch rewards and stored rewards sections render.
    Evidence: .sisyphus/evidence/task-23-redemptions.png
  ```

  **Commit**: YES | Message: `feat(dimasite): rebuild redemptions module page` | Files: `dimasite/src/app/features/redemptions/**`

- [ ] 24. Implement Follow Ledger analytics page parity and backend mount

  **What to do**:
  - Frontend: rebuild follow ledger page (filters, pagination, duration formatting) using i18n keys `analytics.follows.*`.
  - Backend: ensure `/analytics/follows/:channelID` is mounted and reachable.

  **Recommended Agent Profile**:
  - Category: `unspecified-high` — Reason: table UX + backend mount dependency.
  - Skills: []

  **Parallelization**: Can Parallel: NO | Wave 4 | Blocks: final QA | Blocked By: B1

  **References**:
  - Legacy chunk: `olddimasite/dist/browser/chunk-5ANAYUEX.js`.
  - Backend route exists: `dimabot/src/server/routes/analytics.route.ts`.
  - Backend mount point: `dimabot/src/server/server.ts`.

  **Acceptance Criteria**:
  - [ ] `GET /analytics/follows/:channelID` returns 200 when authenticated.
  - [ ] Follow ledger UI renders rows and supports searching.

  **QA Scenarios**:
  ```
  Scenario: Follow ledger loads
    Tool: Playwright
    Steps: Visit `/:streamer/analytics/follows`.
    Expected: Table renders; changing filter updates results.
    Evidence: .sisyphus/evidence/task-24-follow-ledger.mp4
  ```

  **Commit**: YES | Message: `feat(dimasite): rebuild follow ledger page` | Files: `dimasite/src/app/features/follow-ledger/**`, `dimabot/src/server/server.ts`


- [ ] 25. Implement Settings page parity (`/:streamer/settings`)

  **What to do**: Rebuild Settings page from `chunk-LVC3UYXH.js`:
  - Bot status toggles:
    - `PUT /users/active/:channelID` (auth) with `{ active }`
    - `POST /users/chat/:channelID` (auth) with `{ enabled }`
  - Referral management:
    - `GET /referrals/stats` (auth)
    - `GET /referrals/codes` (auth)
    - `POST /referrals/codes` (auth)
    - `DELETE /referrals/codes/:codeId` (auth)
  - Billing portal:
    - `POST /billing/portal` (auth)
  - Match legacy classnames (`settings-*`) and show toast feedback.

  **Recommended Agent Profile**:
  - Category: `unspecified-high` — Reason: multiple authenticated endpoints + form UX.
  - Skills: []

  **Parallelization**: Can Parallel: YES | Wave 4 | Blocks: final QA | Blocked By: 14,15

  **References**:
  - Legacy chunk: `olddimasite/dist/browser/chunk-LVC3UYXH.js`.
  - Backend: `dimabot/src/server/routes/user.route.ts`, `dimabot/src/server/routes/referral.route.ts`, `dimabot/src/server/routes/billing.route.ts`.
  - CSS: `olddimasite/dist/browser/styles-B6DASTEJ.css` — `.settings-*`.

  **Acceptance Criteria**:
  - [ ] Toggling active/chat hits backend and updates UI state.
  - [ ] Referral codes list/create/delete works.

  **QA Scenarios**:
  ```
  Scenario: Referral code create
    Tool: Playwright
    Steps: Visit settings, create a referral code, ensure it appears.
    Expected: Success toast; new code visible.
    Evidence: .sisyphus/evidence/task-25-referral-create.mp4
  ```

  **Commit**: YES | Message: `feat(dimasite): rebuild settings page` | Files: `dimasite/src/app/features/settings/**`

- [ ] 26. Backend: extend AI Personality API to support legacy learningConfig updates

  **What to do**: Update `dimabot/src/server/routes/aiPersonality.route.ts` to accept and persist `learningConfig` in `PUT /ai-personality/:channelID` when provided (legacy frontend sends `{ learningConfig: { ... } }`).
  **Must NOT do**: Do not break existing `{ personality, rules, knownUsers }` update behavior.

  **Recommended Agent Profile**:
  - Category: `unspecified-high` — Reason: backend contract + schema alignment.
  - Skills: []

  **Parallelization**: Can Parallel: YES | Wave 5 | Blocks: 27,28 | Blocked By: none

  **References**:
  - Legacy service: `olddimasite/dist/browser/chunk-5CDLJCZN.js` — `updateLearningConfig()` uses `PUT /ai-personality/:id` with `{learningConfig}`.
  - Schema: `dimabot/src/schemas/channel_ai_personality.schema.ts` — `learningConfig`.
  - Existing route: `dimabot/src/server/routes/aiPersonality.route.ts`.

  **Acceptance Criteria**:
  - [ ] Sending `PUT /ai-personality/:channelID` with `learningConfig` updates stored document.

  **QA Scenarios**:
  ```
  Scenario: Update learning config
    Tool: Bash
    Steps: Curl PUT with auth header and a small learningConfig change; then GET and verify.
    Expected: Returned `data.learningConfig.enabled` matches.
    Evidence: .sisyphus/evidence/task-26-learning-config.txt
  ```

  **Commit**: YES | Message: `feat(dimabot): support ai learningConfig updates` | Files: `dimabot/src/server/routes/aiPersonality.route.ts`

- [ ] 27. Backend: add AI Personality profile endpoints (legacy `/profiles` contract)

  **What to do**: Add endpoints under `dimabot/src/server/routes/aiPersonality.route.ts`:
  - `POST /ai-personality/:channelID/profiles` create profile
  - `PATCH /ai-personality/:channelID/profiles/:profileID` update profile
  - `POST /ai-personality/:channelID/profiles/:profileID/activate` set active profile
  - `DELETE /ai-personality/:channelID/profiles/:profileID` delete profile
  Response envelope must match legacy expectation: `{ error, message?, status?, data }`.

  **Recommended Agent Profile**:
  - Category: `unspecified-high` — Reason: schema manipulation + tier limits.
  - Skills: []

  **Parallelization**: Can Parallel: YES | Wave 5 | Blocks: 28 | Blocked By: 26

  **References**:
  - Legacy endpoints: `olddimasite/dist/browser/chunk-5CDLJCZN.js` — `createProfile/updateProfile/activateProfile/deleteProfile`.
  - Schema profiles: `dimabot/src/schemas/channel_ai_personality.schema.ts` — `profiles`, `activeProfileId`.

  **Acceptance Criteria**:
  - [ ] Profile CRUD works end-to-end and active profile updates derived personality fields.

  **QA Scenarios**:
  ```
  Scenario: Activate profile
    Tool: Bash
    Steps: Create profile, activate it, GET personality.
    Expected: `data.activeProfileId` matches; derived fields updated.
    Evidence: .sisyphus/evidence/task-27-profiles.txt
  ```

  **Commit**: YES | Message: `feat(dimabot): add ai personality profiles endpoints` | Files: `dimabot/src/server/routes/aiPersonality.route.ts`

- [ ] 28. Backend: add AI Memory management endpoints (legacy `/memories` contract)

  **What to do**: Add endpoints under `dimabot/src/server/routes/aiPersonality.route.ts` backed by `ChannelAIMemorySchema`:
  - `GET /ai-personality/:channelID/memories?status?type?limit?skip?query?` returning `{ items, total, role, permissions }`.
  - `POST /ai-personality/:channelID/memories` create memory.
  - `PATCH /ai-personality/:channelID/memories/:memoryId` update memory.
  - `POST /ai-personality/:channelID/memories/:memoryId/approve|reject|archive` with `{ reason }`.
  - `DELETE /ai-personality/:channelID/memories/:memoryId/permanent`.
  Ensure auth required and actor metadata is set from `req.user`.

  **Recommended Agent Profile**:
  - Category: `unspecified-high` — Reason: new backend contract + pagination/search.
  - Skills: []

  **Parallelization**: Can Parallel: YES | Wave 5 | Blocks: 29 | Blocked By: 26

  **References**:
  - Legacy service parsing: `olddimasite/dist/browser/chunk-5CDLJCZN.js` — `getMemories/createMemory/approveMemory/rejectMemory/updateMemory/archiveMemory/permanentlyDeleteMemory`.
  - Schema: `dimabot/src/schemas/channel_ai_memory.schema.ts`.

  **Acceptance Criteria**:
  - [ ] Memory list returns stable pagination and total.
  - [ ] Approve/reject/archive transitions update `status`.

  **QA Scenarios**:
  ```
  Scenario: Memory approve flow
    Tool: Bash
    Steps: Create memory; approve it; list confirmed.
    Expected: Memory status changes to confirmed.
    Evidence: .sisyphus/evidence/task-28-memories.txt
  ```

  **Commit**: YES | Message: `feat(dimabot): add ai memory management endpoints` | Files: `dimabot/src/server/routes/aiPersonality.route.ts`

- [ ] 29. Implement Bot Personality page parity (`/:streamer/settings/bot-personality`)

  **What to do**: Rebuild page from `chunk-GSBV72JO.js`:
  - Load personality via `GET /ai-personality/:channelID`.
  - Update config via `PUT /ai-personality/:channelID` (rules/knownUsers/personality/learningConfig).
  - Manage profiles via `/profiles` endpoints.
  - Use legacy classnames (`bot-personality-*`) and toasts.

  **Recommended Agent Profile**:
  - Category: `unspecified-high` — Reason: complex forms + multiple endpoints.
  - Skills: []

  **Parallelization**: Can Parallel: YES | Wave 4 | Blocks: final QA | Blocked By: 14,15,27

  **References**:
  - Legacy chunk: `olddimasite/dist/browser/chunk-GSBV72JO.js`.
  - Backend: `dimabot/src/server/routes/aiPersonality.route.ts`.
  - Legacy CSS: `.bot-personality-*`.

  **Acceptance Criteria**:
  - [ ] Editing rules and saving persists after refresh.
  - [ ] Creating and activating a profile works.

  **QA Scenarios**:
  ```
  Scenario: Create and activate profile
    Tool: Playwright
    Steps: Create new profile, activate it.
    Expected: UI shows profile as active; GET reflects activeProfileId.
    Evidence: .sisyphus/evidence/task-29-profile-activate.mp4
  ```

  **Commit**: YES | Message: `feat(dimasite): rebuild bot personality page` | Files: `dimasite/src/app/features/bot-personality/**`

- [ ] 30. Implement Memory Management page parity (`/:streamer/settings/memory`)

  **What to do**: Rebuild page from `chunk-PEFMSOIR.js`:
  - List/search/filter memories via `/ai-personality/:channelID/memories`.
  - Approve/reject/archive/permanent delete actions.
  - Match legacy classnames (`memory-*`) and i18n keys.

  **Recommended Agent Profile**:
  - Category: `unspecified-high` — Reason: table UX + moderation actions.
  - Skills: []

  **Parallelization**: Can Parallel: YES | Wave 4 | Blocks: final QA | Blocked By: 14,15,28

  **References**:
  - Legacy chunk: `olddimasite/dist/browser/chunk-PEFMSOIR.js`.
  - Legacy service: `olddimasite/dist/browser/chunk-5CDLJCZN.js`.

  **Acceptance Criteria**:
  - [ ] A memory can be approved and then appears in confirmed filter.

  **QA Scenarios**:
  ```
  Scenario: Approve memory
    Tool: Playwright
    Steps: Approve a pending memory.
    Expected: Status updates; toast success.
    Evidence: .sisyphus/evidence/task-30-memory-approve.mp4
  ```

  **Commit**: YES | Message: `feat(dimasite): rebuild memory management page` | Files: `dimasite/src/app/features/memory/**`

- [ ] 31. Implement Admin Hub + Admin Users pages parity

  **What to do**: Rebuild pages from `chunk-FB2PGTE2.js` and `chunk-PFC3KIVT.js`:
  - Admin hub route `/:streamer/admin`.
  - Admin users route `/:streamer/admin/users` with table, sorting, pagination, delete dialog.
  - Wire endpoints used by legacy admin pages (prefer `/admin-site/*` where present; otherwise `/admins/*`).

  **Recommended Agent Profile**:
  - Category: `unspecified-high` — Reason: complex table UX + modals.
  - Skills: []

  **Parallelization**: Can Parallel: YES | Wave 4 | Blocks: final QA | Blocked By: 14,15

  **References**:
  - Backend: `dimabot/src/server/routes/admin_site.route.ts`, `dimabot/src/server/routes/admin.route.ts`.
  - Legacy CSS: `.admin-*`.

  **Acceptance Criteria**:
  - [ ] Admin users page can search and open delete dialog.

  **QA Scenarios**:
  ```
  Scenario: Admin users dialog opens
    Tool: Playwright
    Steps: Navigate to admin users, click delete on a row.
    Expected: Modal appears with warning text.
    Evidence: .sisyphus/evidence/task-31-admin-delete-dialog.png
  ```

  **Commit**: YES | Message: `feat(dimasite): rebuild admin hub and users pages` | Files: `dimasite/src/app/features/admin/**`

- [ ] 32. Implement Profile Settings + Logout pages parity

  **What to do**:
  - Profile settings route `/:streamer/profile/settings` from `chunk-GMVW4S6D.js`.
  - Logout route clears session and redirects to `/` (legacy `chunk-COQJU4IF.js`).

  **Recommended Agent Profile**:
  - Category: `unspecified-high` — Reason: session lifecycle + form UX.
  - Skills: []

  **Parallelization**: Can Parallel: YES | Wave 4 | Blocks: final QA | Blocked By: 14,15

  **References**:
  - Legacy chunks: `olddimasite/dist/browser/chunk-GMVW4S6D.js`, `olddimasite/dist/browser/chunk-COQJU4IF.js`.
  - Legacy CSS: `.profile-settings-*`.

  **Acceptance Criteria**:
  - [ ] Logout clears `sessionStorage['user']` and ends at `/`.

  **QA Scenarios**:
  ```
  Scenario: Logout
    Tool: Playwright
    Steps: Seed session; visit `/:streamer/logout`.
    Expected: Session cleared; redirect to `/`.
    Evidence: .sisyphus/evidence/task-32-logout.mp4
  ```

  **Commit**: YES | Message: `feat(dimasite): rebuild profile settings and logout` | Files: `dimasite/src/app/features/profile/**`, `dimasite/src/app/features/logout/**`

- [ ] B1. Backend: mount analytics router at `/analytics`

  **What to do**: In `dimabot/src/server/server.ts`, import `analyticsRoute` from `dimabot/src/server/routes/analytics.route.ts` and mount `app.use('/analytics', analyticsRoute)`.
  **Must NOT do**: Do not change route behavior.

  **Recommended Agent Profile**:
  - Category: `quick` — Reason: single mount fix.
  - Skills: []

  **Parallelization**: Can Parallel: YES | Wave 5 | Blocks: 24 | Blocked By: none

  **References**:
  - Route file: `dimabot/src/server/routes/analytics.route.ts`
  - Mount list: `dimabot/src/server/server.ts`

  **Acceptance Criteria**:
  - [ ] Authenticated request to `/analytics/follows/:channelID` returns non-404.

  **QA Scenarios**:
  ```
  Scenario: Endpoint reachable
    Tool: Bash
    Steps: Start server; curl `/analytics/follows/<id>` with an auth header.
    Expected: HTTP 200/4xx (not 404).
    Evidence: .sisyphus/evidence/task-b1-analytics-mount.txt
  ```

  **Commit**: YES | Message: `fix(dimabot): mount analytics routes` | Files: `dimabot/src/server/server.ts`

- [ ] B2. Backend: add `GET /config/site/analytics` (landing snapshot)

  **What to do**: Add an unauthenticated endpoint that returns `getSiteAnalyticsSnapshot()` in the standard envelope `{ error, message, status, data }`.
  **Must NOT do**: No cache writes; read-only.

  **Recommended Agent Profile**:
  - Category: `quick` — Reason: small endpoint using existing utility.
  - Skills: []

  **Parallelization**: Can Parallel: YES | Wave 5 | Blocks: 9 | Blocked By: none

  **References**:
  - Utility: `dimabot/src/utils/siteanalytics.ts` — `getSiteAnalyticsSnapshot()`.
  - Server mounts: `dimabot/src/server/server.ts`.
  - Legacy consumer: `olddimasite/src/main-recovered.js` — endpoint `/config/site/analytics`.

  **Acceptance Criteria**:
  - [ ] `curl http://localhost:3000/config/site/analytics` returns JSON with `data.registeredUsers` etc.

  **QA Scenarios**:
  ```
  Scenario: Snapshot response shape
    Tool: Bash
    Steps: Curl endpoint and verify JSON contains expected keys.
    Expected: Keys present; `error=false`.
    Evidence: .sisyphus/evidence/task-b2-snapshot.json
  ```

  **Commit**: YES | Message: `feat(dimabot): expose landing analytics snapshot endpoint` | Files: `dimabot/src/server/server.ts`

- [ ] B3. Backend: add `GET /config/site/analytics/stream` (SSE) emitting `landing-stats`

  **What to do**: Implement SSE endpoint that:
  - Sets headers: `Content-Type: text/event-stream`, `Cache-Control: no-cache`, `Connection: keep-alive`.
  - Immediately emits `event: landing-stats` with snapshot JSON.
  - Re-emits every 15s.
  - Cleans up interval on client disconnect.

  **Recommended Agent Profile**:
  - Category: `unspecified-high` — Reason: SSE correctness and resource cleanup.
  - Skills: []

  **Parallelization**: Can Parallel: YES | Wave 5 | Blocks: 9 | Blocked By: B2

  **References**:
  - Legacy SSE consumer: `olddimasite/src/main-recovered.js` — `new EventSource(.../config/site/analytics/stream)` and event `landing-stats`.
  - Snapshot: `dimabot/src/utils/siteanalytics.ts`.

  **Acceptance Criteria**:
  - [ ] Opening SSE stream receives `landing-stats` events.

  **QA Scenarios**:
  ```
  Scenario: SSE emits
    Tool: Bash
    Steps: Use `curl -N http://localhost:3000/config/site/analytics/stream` for 20s.
    Expected: At least 1 `event: landing-stats` block.
    Evidence: .sisyphus/evidence/task-b3-sse.txt
  ```

  **Commit**: YES | Message: `feat(dimabot): add landing analytics SSE stream` | Files: `dimabot/src/server/server.ts`

- [ ] 33. Add automated verification suite (unit + e2e + a11y) for core flows

  **What to do**:
  - Unit tests (vitest) for: ThemeService, LanguageService, SessionAuthService, guards.
  - E2E (Playwright MCP or local Playwright) for: landing render, theme toggle, language toggle, protected route redirect, authenticated route crawl.
  - Axe scans on landing + authenticated layout + one CRUD page.

  **Recommended Agent Profile**:
  - Category: `unspecified-high` — Reason: test infra + reliability.
  - Skills: [`playwright`] — browser automation.

  **Parallelization**: Can Parallel: YES | Wave 5 | Blocks: final signoff | Blocked By: 9-32, B1-B3

  **References**:
  - Existing tests: `dimasite/src/app/app.spec.ts`
  - Test config: `dimasite/angular.json`, `dimasite/tsconfig.spec.json`

  **Acceptance Criteria**:
  - [ ] `cd dimasite && npm run test` passes.
  - [ ] E2E evidence files exist for the listed flows.

  **QA Scenarios**:
  ```
  Scenario: Full build + test
    Tool: Bash
    Steps: `cd dimasite && npm run build && npm run test`.
    Expected: exit 0.
    Evidence: .sisyphus/evidence/task-33-tests.txt
  ```

  **Commit**: YES | Message: `test(dimasite): add unit and e2e coverage for rebuild` | Files: `dimasite/src/**/*.spec.ts`, `dimasite/**`

## Final Verification Wave (4 parallel agents, ALL must APPROVE)
- [ ] F1. Plan Compliance Audit — oracle
- [ ] F2. Code Quality Review — unspecified-high
- [ ] F3. Real Manual QA (agent-executed via Playwright MCP) — unspecified-high
- [ ] F4. Scope Fidelity Check — deep

## Commit Strategy
- Commit per major milestone (core plumbing, router/layout, each major feature cluster, backend parity).

## Success Criteria
- UI route parity + styling parity + auth/i18n/theme/tier parity confirmed by Playwright screenshots and backend endpoint smoke checks.
