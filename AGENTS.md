# SaaS Workspace Agent Guide

This workspace has two active projects plus one legacy reference project. Use the correct folder before making changes.

## Project map

- `dimabot/`: backend + Twitch bot (Node.js/TypeScript). This is where API routes, bot logic, and server/websocket live.
- `dimasite/`: Angular frontend app. This is where pages/components/services for the website frontend live.
- `oldsite/`: legacy Angular v19 website. Use this as a reference for UI design, flow, and business logic only.

## Where to edit for each type of change

- Backend HTTP API: `dimabot/src/server/routes/*.route.ts`
- Backend route registration: `dimabot/src/server/server.ts`
- Backend websocket contracts/events: `dimabot/src/server/websocket.ts`
- Bot-side features/commands: `dimabot/src/functions/**`, `dimabot/src/handlers/**`, `dimabot/src/classes/**`
- Frontend UI/routes/services: `dimasite/src/app/**`
- Legacy UI/logic reference (read-only unless requested): `oldsite/src/**`

## Cron workers architecture (important)

- `dimabot` uses a single cron host process via `dima-cron` container.
- The cron host entrypoint is `dimabot/src/workers/cron.index.ts` (built as `dist/workers/cron.index.js`).
- `cron.index.ts` is a supervisor that starts and monitors cron workers and self-heals by restarting only the failed worker.
- Current workers managed by supervisor:
  - `src/workers/follow_ledger.worker.ts`
  - `src/workers/stream_analytics.worker.ts`
- To add future cron jobs, create a new `*.worker.ts` and register it in the `WORKERS` array in `cron.index.ts`.
- Do not split into new containers by default; prefer extending `dima-cron` unless resource isolation is explicitly requested.

## Current frontend status (important)

- `dimasite/src/app/app.routes.ts` has routes for landing, login, and authenticated layout with dashboard child routes.
- API service layer exists: `dimasite/src/app/services/dashboard-api.service.ts`, `session-auth.service.ts`, `language.service.ts`, `theme.service.ts`.
- Authenticated layout with navbar: `dimasite/src/app/features/layout/authenticated-layout.component.ts`.
- `oldsite/` exists as the prior Angular v19 implementation and should be used as a migration/reference source.

## Oldsite -> Dimasite migration policy (important)

- Do not do a full or blind migration from `oldsite/` into `dimasite/`.
- Use `oldsite/` as a reference for visual design, UX behavior, copy, and feature intent.
- Build all new/ported code in `dimasite/` using modern Angular v21 patterns and current project conventions.
- When porting logic, proactively improve security, reliability, and developer experience:
  - replace deprecated APIs/patterns
  - avoid unsafe HTML/script usage
  - tighten input validation and typing
  - remove fragile or outdated code paths
  - prefer maintainable, testable abstractions
- If `oldsite/` behavior conflicts with current backend contracts or product requirements, follow current contracts/requirements and adapt the frontend accordingly.
- Do not modify `oldsite/` unless explicitly requested.

## Backend API base

- Local dev server starts from `dimabot/src/server/index.ts` and listens on port `3000`.
- Main route mounts are defined in `dimabot/src/server/server.ts`.

## Mounted route groups and contracts

These are currently mounted in `dimabot/src/server/server.ts`.

### `GET /config/commands/reserved`
- Expects: no body.
- Returns: `{ error, message, status, data }` with reserved command definitions.

### `/auth`
- `GET /auth/register`
  - Expects query: `code`, `state` (state = username).
  - Returns: redirect to login page on success.
- `GET /auth/reauthenticate`
  - Expects query: `code`, `state`.
  - Returns: redirect to login page on success.
- `POST /auth/login`
  - Expects body: `{ id, name?, email? }` (`name` and `email` required for new user creation).
  - Returns: user summary (`name`, `email`, `plan_tier`, `actived`, `chat_enabled`, `twitch_user_id`, etc.).
- `GET /auth/mock-register`
  - Expects query: `state` (username).
  - Returns: redirect to login page.
- `POST /auth/repair`
  - Expects authenticated user context (`req.user.id`).
  - Returns: count of repaired EventSub subscriptions.
- `POST /auth/factory-reset`
  - Returns `501` (not implemented yet).

### `/billing` (auth required)
- `GET /billing/context`
  - Expects query: `targetPlan?` (`premium|pro`), `action?` (`auto|new|upgrade|change|reactivate`).
  - Returns billing context in `data`.
- `POST /billing/checkout`
  - Expects body: `{ targetPlan, action?, promoCode?, successUrl?, returnUrl?, referralCode? }`.
  - Returns checkout info: `{ checkoutUrl, checkoutId, scenario, appliedDiscount, allowDiscountCodes }`.
- `POST /billing/portal`
  - Expects body: `{ returnUrl? }`.
  - Returns portal session: `{ sessionId, url, expiresAt }`.

### `/users`
- `GET /users?username=<login>`
  - Expects query: `username`.
  - Returns Twitch user profile subset.
- `GET /users/:channelID`
  - Expects param: `channelID`.
  - Returns streamer data (without refresh token).
- `GET /users/scopes/:userID`
  - Expects param: `userID`.
  - Returns granted scopes.
- `POST /users/premium`
  - Expects body: `{ channel, channelID }`.
  - Returns: `premium` status (`none|premium|premium_plus`).
- `GET /users/active/:channel`
  - Expects param: `channel` login.
  - Returns: `{ active: boolean }`.
- `PUT /users/active/:channelID` (auth required)
  - Expects body: `{ active: boolean }`.
  - Returns success message.
- `POST /users/chat/:channelID`
  - Expects body: `{ enabled: boolean }`.
  - Returns success message.

### `/admins` (auth required)
- `GET /admins/:channelID`
  - Expects optional query: `page`, `limit`, `sort`, `order`, `name`, `id`.
  - Returns paginated admin list.
- `GET /admins/:channelID/:adminID`
  - Expects params: `channelID`, `adminID`.
  - Returns admin data from cache.
- `POST /admins/:channelID`
  - Expects body: `{ channelName, adminName }`.
  - Returns creation success.
- `DELETE /admins/:channelID/:adminID`
  - Expects params: `channelID`, `adminID`.
  - Returns deletion success.

### `/commands`
- `GET /commands`
  - Expects optional query: `limit`, `skip`.
  - Returns all commands page.
- `GET /commands/:channelID`
  - Expects optional query: `limit`, `skip`.
  - Returns commands for one channel.
- `POST /commands/:channelID` (auth required)
  - Expects body fields: `name`, `cmd`, `func`, `message`, `channel` (+ optional command metadata).
  - Returns created command.
- `PUT /commands/:channelID/:commandID` (auth required)
  - Expects body: partial command update.
  - Returns updated command.
- `DELETE /commands/:channelID/:commandID` (auth required)
  - Expects params: `channelID`, `commandID`.
  - Returns deleted command.

### `/eventsubs` (auth required)
- `GET /eventsubs/:channelID`
  - Expects optional query: `type`, `id`.
  - Returns matching eventsub records.
- `POST /eventsubs/:channelID`
  - Expects body: `{ type, version, condition, config? }`.
  - Returns created subscription data.
- `DELETE /eventsubs/:channelID/:id`
  - Expects params: `channelID`, `id`.
  - Returns deletion result.
- `PATCH /eventsubs/:channelID/:id`
  - Expects params + partial body update.
  - Returns update result.

### `/ai-personality`
- `GET /ai-personality/:channelID`
  - Expects param: `channelID`.
  - Returns personality plus derived tier limits.
- `PUT /ai-personality/:channelID` (auth required)
  - Expects body: `{ personality?, rules?, knownUsers? }`.
  - Returns updated personality.
- `POST /ai-personality/:channelID/known-users` (auth required)
  - Expects body: `{ username, description?, relationship? }`.
  - Returns updated personality with known users.

### `/rewards` (auth required)
- `GET /rewards/twitch/:channelID`
  - Expects param: `channelID`.
  - Returns Twitch custom rewards from Helix.
- `GET /rewards/:channelID`
  - Expects optional query: `id` or `type`.
  - Returns stored rewards from DB.
- `POST /rewards/:channelID`
  - Expects body with reward creation fields (`title`, `cost`, optional behavior fields).
  - Returns created reward record.
- `PATCH /rewards/:channelID/:id`
  - Expects body with reward updates.
  - Returns updated reward.
- `DELETE /rewards/:channelID/:id`
  - Expects params: `channelID`, Twitch reward `id`.
  - Returns deletion status.

### `/triggers` (auth required)
- `GET /triggers/:channelID`
  - Expects optional query: `id` or `name`.
  - Returns trigger list.
- `POST /triggers/:channelID`
  - Expects body: trigger fields (`name`, `file`, `type`, `mediaType`, `cost`, etc.).
  - Returns created trigger.
- `PATCH /triggers/:channelID/:triggerID`
  - Expects body: trigger update fields.
  - Returns updated trigger.
- `DELETE /triggers/:channelID/:triggerID`
  - Expects params.
  - Returns deleted trigger.
- `POST /triggers/:channelID/send`
  - Expects body: trigger payload for websocket emit.
  - Returns emit confirmation.
- `POST /triggers/:channelID/upload`
  - Expects multipart form-data:
    - file field: `trigger`
    - body field: `triggerName`
  - Returns uploaded file metadata.
- `GET /triggers/files/:channelID`
  - Expects optional query: `id` or `name`.
  - Returns trigger file list.
- `DELETE /triggers/files/:channelID/:fileID`
  - Expects params.
  - Returns deleted file info.

### `/site` (auth required)
- `GET /site/`
  - Returns currently empty object (placeholder).
- `POST /site/events`
  - Expects event config object with required fields:
    - `name`, `type`, `icon`, `color`, `textColor`, `description`, `config`
  - `description` and each `config[].label` must include `EN` and `ES`.
  - Returns created event.
- `GET /site/events`
  - Returns all events.
- `GET /site/events/:type`
  - Returns one event by type.
- `PATCH /site/events/:id`
  - Expects partial event update.
  - Returns updated event.

### `/referrals`
- `GET /referrals/stats` (auth required)
  - Returns referral stats for current user.
- `GET /referrals/codes` (auth required)
  - Returns user referral codes and plan limits.
- `POST /referrals/codes` (auth required)
  - Expects body: `{ code, label? }`.
  - Returns created referral code.
- `DELETE /referrals/codes/:codeId` (auth required)
  - Deletes a user code.
- `POST /referrals/apply` (auth required)
  - Expects body: `{ code }`.
  - Applies referral code to current account.
- `GET /referrals/validate/:code`
  - Public validation endpoint.

### `/clip`
- `GET /clip/:channelID`
  - Expects optional query: `design` (`1|2|3` currently supported).
  - Returns `clip.html` page.
- `POST /clip/test`
  - Expects body: `{ channelID, streamer }`.
  - Returns promo/test result.

### `/video`
- `GET /video/clip/:channelID`
  - Expects param: `channelID`.
  - Returns clip MP4 (supports range requests).

### `/polar/webhook`
- `POST /polar/webhook`
  - Expects raw JSON body signed by Polar.sh.
  - Returns `202` when accepted.

## Websocket namespaces (backend -> frontend/overlay contract)

Defined in `dimabot/src/server/websocket.ts`:

- `/clip/:channelID`
  - Client sends: `ping`, `clip-ended`.
  - Server uses Redis/pubsub clip queue and connection flags.
- `/speech/:channelID`
  - Server emits: `speech`.
  - Client sends: `speech-ended`.
- `/overlays/triggers/:channelID`
  - Server emits trigger events from `/triggers/:channelID/send`.
- `/site/analytics/:type`
  - Emits site analytics snapshots for supported `type` values.

## Important note on non-mounted route files

The following route files exist under `dimabot/src/server/routes/` but are not currently mounted in `dimabot/src/server/server.ts`:

- `overlay.route.ts`
- `validation.route.ts`
- `twitch.route.ts`

Do not assume they are reachable until they are mounted.

## Frontend-backend sync rules

When changing API behavior:

1. Update backend route implementation in `dimabot/src/server/routes/...`.
2. Ensure route mount exists in `dimabot/src/server/server.ts`.
3. Update frontend API service types/calls in `dimasite/src/app/...`.
4. Keep request body/query names and response fields aligned.
5. Prefer a shared envelope in frontend models:
   - `{ error: boolean, message?: string, status?: number, data?: T }`

When changing frontend feature requirements:

1. Confirm endpoint exists and is mounted.
2. Confirm expected params/body and response shape in route file.
3. Implement UI using typed request/response interfaces.

## Frontend i18n (internationalization)

### Overview

The `dimasite` frontend uses a signal-based i18n system without external dependencies.

### Key files

- **Translation dictionaries**: `dimasite/src/assets/i18n/en.json`, `dimasite/src/assets/i18n/es.json`
  - These JSON files are the source of truth for frontend copy
  - Keep both files synchronized when adding or changing keys
- **Language service**: `LanguageService` (provided in root)
  - `currentLanguage` signal (`'en' | 'es'`)
  - `translate(key: string, params?)` method for nested key lookup
  - `toggleLanguage()` to switch between EN/ES
  - Stores preference in localStorage
- **Language JSON loading**: `dimasite/src/app/services/language.service.ts`
  - Imports translation JSON files and resolves keys via dot notation

### Adding/modifying translations

1. Open `dimasite/src/assets/i18n/en.json` and `dimasite/src/assets/i18n/es.json`
2. Add/modify matching keys in both files
3. Use dot notation in templates: `{{ t('navbar.dashboard') }}`
4. For parameterized strings: `{{ t('greeting', { name: userName }) }}` (uses `{{name}}` in translation)

### Usage in components

```typescript
// Inject the service
protected readonly languageService = inject(LanguageService);

// Use in template
protected t(key: string): string {
  return this.languageService.translate(key);
}
```

```html
<h1>{{ t('dashboard.title') }}</h1>
```

### Language toggle

The authenticated navbar includes a language toggle button that calls `LanguageService.toggleLanguage()`.

## Frontend forms policy (important)

- For new form work in `dimasite/`, use Angular v21 signal forms from `@angular/forms/signals` by default.
- Do not introduce template-driven forms for new features.
- Use reactive `FormGroup` APIs only when required for compatibility with legacy integrations.

## Frontend authenticated layout

### Overview

All authenticated routes use a shared layout shell with a consistent navbar.

### Key files

- **Layout component**: `dimasite/src/app/features/layout/authenticated-layout.component.ts/html/css`
- **Route structure**: `dimasite/src/app/app.routes.ts`
  - `/:streamer` route loads `AuthenticatedLayoutComponent`
  - Children: `dashboard`, `commands`, `settings`

### Navbar features

- Brand link with logo
- Navigation links (Dashboard, Commands, Settings)
- Theme toggle (uses `ThemeService`)
- Language toggle (uses `LanguageService`)
- User avatar dropdown with profile/settings/logout
- Auth validation on route changes

### Theme service

`ThemeService` manages theme state globally:

- `theme` signal: `'light' | 'dark' | 'system'`
- `isDarkMode` signal: computed boolean
- `toggleTheme()` to cycle through themes
- Applies `data-theme` attribute to `<html>`
- Stores preference in localStorage

### Auth guards

- **`authenticatedGuard`**: Checks session exists + validates token against `/site/` endpoint
- **`dashboardAccessGuard`**: Resolves streamer + verifies access via `/dashboard/:channelID/access`

### Adding new authenticated routes

1. Add child route under `/:streamer` in `app.routes.ts`
2. Create component in `dimasite/src/app/features/...`
3. Add nav link in `authenticated-layout.component.html` under `.auth-navbar__nav`
4. Add translation keys in `dimasite/src/assets/i18n/en.json` and `dimasite/src/assets/i18n/es.json` for navbar items

## Frontend styling policy (important)

- To prevent Angular `anyComponentStyle` budget warnings/errors, place frontend CSS in `dimasite/src/styles.css` by default.
- Avoid adding non-trivial CSS to component-level `*.component.css` files.
- If a tiny component-scoped override is absolutely needed, keep it minimal and document why.

## Plan tier styling rule (important)

- For authenticated UI, use the `plan_tier` field (`free|premium|pro`) as the source of truth.
- Premium users should receive subtle gold accents (borders/glow/highlight details).
- Pro users should receive a stronger gold treatment than premium, while keeping readability and WCAG AA contrast.
- Free users keep the default visual treatment.
- Prefer applying tier styles through a global attribute hook (for example `data-plan-tier` on `<html>`) so future components can reuse the same system.

This file is the root navigation guide so agents know exactly where to work and how frontend/backend contracts connect.
