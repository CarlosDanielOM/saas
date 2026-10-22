# SaaS Workspace Agent Guide

**This is the root navigation document for the entire monorepo.** All agents must read this file first.

## Production Host & Delivery Workflow

**This checkout, `/root/saas`, is on the actual production server.** Docker and live services are available here. Do not assume this is a development-only machine or that Docker is unavailable. Confirm current container mounts and Compose ownership before acting; the paths below describe this host.

**A request to implement a change authorizes the complete delivery workflow: edit, validate in isolation, clean up temporary resources, deploy the affected services, and verify production.** Proceed without asking again for routine builds or targeted deployment after validation passes. Respect narrower requests such as review-only, plan-only, or do-not-deploy. Destructive data changes or infrastructure changes outside the requested scope require separate authorization.

### Read-only production diagnostics

Agents may freely use **read-only** inspection commands against live services when investigating issues — no deployment workflow or extra authorization is required. This includes:

- `docker ps`, `docker logs <container>` (e.g. `dima-bot`, `dima-server`, `dima-cron`), `docker inspect`, `docker exec <container> printenv`
- Read-only queries inside data containers, e.g. `docker exec dragonfly redis-cli get/hgetall/scan` and `docker exec mongodb mongosh <uri> --eval '<read-only query>'` (reuse the service's own connection URI from its container env; never write, update, or delete)
- Application debug logs stored in Dragonfly under `logger:<platform>:<channelId>:<level>:<logId>` (7-day TTL), which capture `cache`-destination entries that never reach container stdout

Never mutate live data, restart containers, or alter configuration under the guise of diagnostics.

### Use the executable agent workflow

**For supported code/assets releases, agents must use `scripts/saas-ops` rather than assembling Docker or publication commands manually.** Read [`ops/README.md`](ops/README.md) for the exact workflow and limits. Start with `scripts/saas-ops list` and `scripts/saas-ops plan <target>`, then `build <target>`, `verify <run-id> --check <behavior-script>`, `deploy <run-id>`, and `cleanup <run-id>`. The generated run ID fixes the target throughout verification, deployment, rollback, and cleanup. No arguments prints help; there is no bulk target or automatic Git pull.

**`scripts/dima-update` is the human operator's manual tool. Agents must not invoke or modify it.** It is intentionally separate from the agent workflow.

The helper snapshots current project files, tests a candidate, promotes the exact tested image/bundle, checks ownership before cleanup, and preserves rollback artifacts. Checks must exercise the changed feature; the supplied smoke checks are only a baseline. Use `preview site|admin|docs` for isolated frontend development previews. Configuration/migration changes and the directly served `dimafx` client require their separately reviewed workflows; do not work around a helper refusal with a broad Docker command.

### Backend and container services

1. Identify affected services from the implementation and its consumers, then inspect their Dockerfiles, commands, mounts, and dependencies.
2. Build a candidate image with a unique temporary tag and run a disposable container using the intended runtime command. Use a separate test configuration, private test network, disposable data, and mocks or test dependencies as needed. Bind any preview ports to `127.0.0.1` on unused ports. Limit CPU/memory appropriately for the host's available capacity.
3. Do not blindly reuse production Compose configuration for testing: it contains fixed container names, production networks, credentials, and volumes. A different Compose project name alone does not isolate those resources. Test containers must not consume live queues, run duplicate bots/workers, mutate production databases, send real messages, or trigger billing/webhooks. Inspect initialization side effects before starting them.
4. Check startup/readiness and exercise the changed behavior, including relevant failure cases. A successful image build or a container that stays running is not sufficient functional verification. For example, a TTS custom-ID change should exercise synthesis with supported custom IDs and invalid/missing IDs using disposable fixtures. If runtime verification is blocked, report the specific gap; do not label a build-only check as a passed runtime test or deploy an unverified change.
5. Stop and remove task-owned test containers, networks, and disposable volumes after testing, including after failures. Remove temporary images when no longer needed. Never use broad Docker prune commands or remove unrelated resources.
6. After checks pass, use `scripts/saas-ops deploy <run-id>` to preserve the previous production image/configuration and recreate only the selected service with the exact tested image. Do not rebuild a different image during deployment. Check readiness, recent logs, and a scoped production smoke test. If deployment introduces a regression, use the run's rollback command and report the failure.

### Cron worker verification scope

Prior user approval of unchanged workers carries forward across cron releases. Fully verify each new or changed worker against the exact candidate image. Retest an existing worker only when its code, a relevant dependency, or shared runtime behavior actually changes in a way that can affect it; a new Cargo feature, registry entry, or shared image by itself does not establish that impact. Scope regression checks to the identified impact and explain the connection before expanding coverage; this is not a user-approval gate. After replacing the cron container, check startup and health for every existing worker. Preserve isolated exact-candidate checks for changed behavior, deployment readiness and rollback safeguards, and the hard build limits in the Rust guide and ops workflow.

### Frontend and static content

- Use a development preview before deployment: Angular `ng serve` with the project's development configuration, or Astro's development server. Bind previews to loopback on an unused port. Inspect mobile and desktop layouts and exercise changed interactions. A preview may still call production APIs: inspect its environment/proxy configuration and use mocks or test accounts/data for mutating flows.
- Use `scripts/saas-ops build site|admin|docs` to create the production bundle outside the live mount, then verify that candidate with a behavior check.
- Once validation passes, use `deploy <run-id>` to back up and publish the tested bundle, verify the live page/assets, and stop the preview. The helper replaces individual files with HTML last, preserves the mount directory, and restores the previous bundle on failure. This is not a whole-site atomic switch.
- `dimafx` client files are served directly from the checkout. Prepare and preview those edits in an isolated copy/worktree outside the served directory, then apply the validated files as the deployment step.

### Live deployment map

| Project | Production update mechanism |
|---------|-----------------------------|
| `dimasite` | Helper target `site` publishes to `dimasite/dist/dimasite/browser/`, served by `dimabot-site` |
| `admin` | Helper target `admin` publishes to `admin/dist/admin/browser/`, served by `dima-admin` |
| `dimadocs` | Helper target `docs` publishes to `dimadocs/dist/`, served by `dimadocs` |
| `dimafx` client | `dimafx/` is mounted directly into `dimafx`; client file edits are immediately live |
| `dimabot` | Helper targets `api`, `bot`, `cron`, `piper`, `embeddings` use `dimabot/docker-compose.yaml` |
| `dimafx` server | Helper target `dimafx-server` uses `dimafx/docker-compose.yml` |
| `dimadb` | Helper target `dimadb` uses `dimadb/docker-compose.yaml`; `dimadb/data/` is persistent production data |
| `dima-analytics` | First install uses `ops/bootstrap_analytics.py`; later releases use helper target `analytics` and `dima-analytics/docker-compose.yaml` |

The static sites have their own Compose files in their project directories. Nginx Proxy Manager fronts them; it does not own their Compose lifecycle. Content updates do not require nginx restarts. Nginx configuration changes require validation and a targeted reload.

Changes limited to repository guidance (such as `AGENTS.md` or architecture Markdown) require documentation checks, not application builds, test containers, or deployment. Published documentation-site content still follows the `dimadocs` preview/build/deploy workflow. In the final report, state what was verified, what was deployed, and any unresolved limitations.

## Monorepo Structure

This workspace is a **single git repository** (`saas/`) containing seven existing application projects and the `dima-rust/` Rust project. There are no nested `.git` folders. Run repository operations from the relevant checkout root; use isolated worktrees/copies when required by the production workflow above.

- Each application subproject manages its own `package.json` and `package-lock.json`; `dima-rust/` uses Cargo manifests and a tracked `Cargo.lock`.
- Root `.gitignore` explicitly allows per-project lockfiles.
- Branch policy: `master` (do not rename without explicit request).

## Project Map

| Project     | Purpose                              | Tech Stack                  | Key Entry Points                              |
|-------------|--------------------------------------|-----------------------------|-----------------------------------------------|
| `dimabot/`  | Backend API + Twitch bot + workers   | Node.js / TypeScript        | `src/server/index.ts`, `src/server/server.ts`, `src/workers/cron.index.ts` |
| `dimasite/` | Public-facing Angular frontend       | Angular v21 + Signals       | `src/app/app.routes.ts`, `src/styles.css`     |
| `admin/`    | Internal admin panel                 | Angular v21                 | `src/app/app.routes.ts`                       |
| `dimadocs/` | Documentation site (public)          | Astro + MDX                 | `astro.config.mjs`, `src/content/docs/`       |
| `dimafx/`   | Twitch Extension (client + server)   | HTML/JS + Node.js           | `server/src/server.ts`, `panel.html`, `config.html` |
| `dimadb/`   | Internal DB console (Redis first)    | Angular v22 + Node          | `src/app/app.routes.ts`, `server/index.mjs`         |
| `dima-analytics/` | Private observability and resource analytics service | Node.js / Express + PostgreSQL | `src/index.mjs`, `src/store.mjs`, `src/collectors.mjs` |
| `dima-rust/` | Rust library and seven accepted native cron workers | Rust | `Cargo.toml`, `src/lib.rs`, `src/workers/`, `src/bin/` |

`dima-rust/` contains shared library utilities and seven accepted production workers wired as separately supervised children of the existing dimabot cron host. Dashboard activity was deployed as the seventh native child in run `cron-bf400acbc441`, image `sha256:72df59845ea803f1f619e8d9cfa748a881a0dd0de246da720815a9f8182fda30`, at `2026-10-21T22:53:29.834585977Z`. All twelve same-image suites passed (nine suites totaling 150 groups, plus three candidate-specific supplemental legacy checks totaling four reported groups). The 32-sample production watch passed across 332.216 seconds, readbacks and binary identities passed, only `dima-cron` changed among 17 containers, and helper cleanup passed. The release has seven accepted native workers. Roll back with `scripts/saas-ops rollback cron-bf400acbc441` to accepted run `cron-9ff771d91cda`, image `sha256:2a009af0d0fabef6bd2103ef04596ed6451a1ce360c73b32c9146f8ce3878102` (six Rust workers and the prior TypeScript dashboard worker). The new image has no TypeScript dashboard fallback. The prior accepted run's nine exact-image suites (120 groups), 190.802-second watch, readbacks, container comparison, and cleanup passed before deployment at `2026-10-21T20:58:08.390836997Z`. That release includes AI-receipts and roulette backlog scheduling plus coordinated email-template commit `c5288218`; its email check was required for that combined candidate only. The older rollback image `cron-7a8ca7924412` keeps six Rust workers with prior cadence and older cron email templates and does not restore a TypeScript fallback. `scripts/saas-ops build cron` stages native binaries into the existing cron image; it adds no production service or Compose container. Historical five-worker image `cron-7b8a6c88303d`, TypeScript retirement run `cron-d02bf5a387d5`, and raid-sessions release `cron-7a8ca7924412` retain their original acceptance facts. See [`migration-notes/dashboard-activity.md`](migration-notes/dashboard-activity.md), [`migration-notes/typescript-worker-retirement.md`](migration-notes/typescript-worker-retirement.md), [`migration-notes/raid-sessions.md`](migration-notes/raid-sessions.md), [`migration-notes/worker-backlog-scheduling.md`](migration-notes/worker-backlog-scheduling.md), and [`migration-notes/README.md`](migration-notes/README.md). Detailed stream behavior and benchmarks remain in [`dima-rust/STREAM_ACTIVITY.md`](dima-rust/STREAM_ACTIVITY.md).

The scheduled stream-activity, raid-analytics, follow-defense baseline, roulette-completion, AI-usage-receipts, raid-sessions, and dashboard-activity TypeScript entrypoints are retired from the application source tree and preserved in [`archives/typescript-workers/2026-10-21`](archives/typescript-workers/2026-10-21/README.md). The first five were accepted as native Rust in `cron-d02bf5a387d5`; raid sessions was accepted as the sixth source integration in `cron-7a8ca7924412`; dashboard activity is the seventh accepted native worker in `cron-bf400acbc441`. Its nine exact-image suites passed 150 groups and three candidate-specific supplemental legacy checks reported four groups. The 32-sample production watch passed in 332.216 seconds, final readbacks passed, only `dima-cron` changed among 17 containers, and helper cleanup passed. Production runs image `sha256:72df59845ea803f1f619e8d9cfa748a881a0dd0de246da720815a9f8182fda30` with seven native children. Rollback is `scripts/saas-ops rollback cron-bf400acbc441` to six-worker accepted image `cron-9ff771d91cda`; the new image has no TypeScript fallback. These checks document that candidate's acceptance; they do not establish a standing suite count. Former TypeScript runtime selectors are retired where they historically existed; no `RAID_SESSIONS_RUNTIME` selector existed. Native child failures restart that Rust child without a TypeScript fallback. Other TypeScript workers, producers, APIs, action execution, and shared helpers remain active. See [`migration-notes/dashboard-activity.md`](migration-notes/dashboard-activity.md), [`migration-notes/typescript-worker-retirement.md`](migration-notes/typescript-worker-retirement.md), and [`migration-notes/raid-sessions.md`](migration-notes/raid-sessions.md).

**Rule**: When asked to make a change, first identify which project owns the feature, then read that project's `AGENTS.md` (if present) before editing.

## Reuse-First Discovery

Before implementing data-dependent features or functions that may duplicate existing behavior, search and trace the relevant collectors, schemas, registries, events, workers, caches/aggregations, APIs/services, and their callers. Record which existing sources are reusable and the specific gap that remains. Prefer direct reuse or a safe extension before adding a parallel path. A derived read model or rollup is appropriate when it serves a distinct query need and reuses existing data. A dedicated function is appropriate when adapting an existing path would be too coupled or costly; where real logic overlaps, consider a small modular shared core. Do not force a universal abstraction, and do not add a confirmation gate for this discovery or routine reuse decision.

## GPT-Led Orchestration

- This policy applies only to GPT-led sessions. For GPT-led UI/UX and design tasks, use DeepSeek V4.1 Flash or GPT-6.1 Sol with the existing effort preferences. The user may manually ask Claude to refine the result later; this guidance does not impose a default on Claude-led sessions.
- Before substantive delegation, read [`orchestrator-notes/README.md`](orchestrator-notes/README.md) for current routing notes. Treat the user's current ascending capability coding tier as a starting preference: GPT-6 Luna → MiniMax M3.1 Flash → DeepSeek V4.1 Flash → Grok 4.7 → GPT-6.1 Sol → GPT-6 Astra. Use evidence-backed adjustments to the working tier and task-category routing without asking for another approval, and select the appropriate model up front rather than requiring a sequential escalation ladder. Record the dated reason and evidence, retaining the user-provided baseline. Update the notes after meaningful verified outcomes or user feedback. Model IDs and available effort options must still come from the live catalog below; do not treat notes as permanent capability data.
- Keep `orchestrator-notes/README.md` an approximately one-page routing summary with confidence and evidence links; put detailed observations in dated files and link release/migration evidence instead of copying release diaries. Follow its maintenance policy. Make justified task-specific routing adjustments without approval; do not infer a broad tier reorder from unmatched tasks or one result.
- GPT-led sessions must delegate substantive implementation through bounded tasks by default. Direct edits are appropriate for truly small tasks, such as an isolated typo, a short copy change, or a tiny mechanical adjustment; this exception does not cover a feature or multi-file implementation.
- Choose delegates by task: DeepSeek V4.1 Flash via OpenCode Go suits scoped exploration at high or max; based on the user's experience, Grok 4.7 is their preferred option with stronger reasoning for more demanding/deeper exploration, and is also available for scoped implementation through Cursor and Grok CLI. Use Grok 4.7 at high or xhigh when the live catalog advertises those effort levels. This is a user routing preference, not a verified benchmark. MiniMax Code M3.1 Flash is suitable for exploration or implementation at high, xhigh, or max, scaled to complexity; GPT-6 Luna at high is mainly for exploration and documentation; GPT-6.1 at high/xhigh and GPT-6 Astra at medium/high are preferred for substantial coding. Avoid using GPT-6.1 or Astra for routine exploration. DeepSeek and MiniMax are also good implementation choices when the scope fits.
- Before delegation, inspect the live `orchestrator_capabilities` catalog for provider/model availability, exact selection identifiers, supported options, and native child-task support. Use native subagents for supported same-provider models; use T3 `delegate_task` for cross-provider work or models unavailable through native subagents. Do not hardcode stale IDs or invent effort settings. If a preferred model exposes only a thinking variant or lacks the requested high/xhigh/max control, preserve the preference as far as its advertised options allow and report the limitation; do not fabricate options.
- For delegated non-Claude work, default to `runtimeMode: 'full-access'` when advertised and permitted by the parent and platform. For MiniMax full-access work, use `permissionMode: 'bypassPermissions'` when advertised. Do not launch Claude as Unix root (UID 0) with full access or bypassed permissions; use a supported mode or another provider. Always inspect the live catalog and honor parent limits. If a requested mode is refused or unavailable, report the limitation and use an authorized supported alternative; do not invent options, bypass a refusal, or add an approval gate. Stay within the task's authorization and the production workflow above.
- The GPT lead defines bounded tasks, shares only the context each needs, and assigns parallel work only to independent scopes within actual concurrency capacity. Do not recursively delegate by default. The lead reviews findings and changes, integrates them, and owns the required verification, deployment, and final report under the existing workflows. Delegation adds no approval gate.

## Documentation Work

- When the active agent or harness provides GPT-6 Luna, use GPT-6 Luna in **high reasoning/thinking mode** for documentation updates.
- For a broad docs refresh, delegate source-backed audits to separate agents when the harness permits it. Give each agent a non-overlapping set of files and feature sources, stay within the actual concurrency limit, and have one integrator reconcile terminology and English/Spanish parity.
- Delegation does not replace verification. Repository guidance changes need a reviewed diff and `git diff --check`; published `dimadocs` content still needs the docs preview, candidate build, behavior check, deployment, and production verification described above.

## Where to Edit – Quick Reference

**Backend (dimabot)**:
- HTTP routes: `dimabot/src/server/routes/*.route.ts`
- Route registration: `dimabot/src/server/server.ts`
- WebSocket events/contracts: `dimabot/src/server/websocket.ts`
- Bot commands/handlers: `dimabot/src/commands/**`, `dimabot/src/handlers/**`, `dimabot/src/functions/**`
- Cron workers: `dimabot/src/workers/*.worker.ts` (register in `cron.index.ts`)

**Frontend (dimasite)**:
- Pages/components/services: `dimasite/src/app/**`
- **Design system: Live First (OC3c)** — agents must read the `live-first` skill before any dimasite UI work. It is registered for each harness: Claude Code `.claude/skills/live-first/SKILL.md` (source of truth), Codex `.agents/skills/live-first` (symlink to the Claude copy), OpenCode `.opencode/skills/live-first/SKILL.md` (copy — keep identical when editing)
- Production references: landing `/`, tip `/tip/:streamer`, dashboard `/:streamer/dashboard`, auth layout
- Global design tokens + shared utilities: `dimasite/src/styles.css`
- Component-scoped styles: `*.component.css` (encouraged for page-level or reusable blocks)
- Route guards: `dimasite/src/app/guards/**`
- i18n: `dimasite/src/assets/i18n/{en,es}.json`

**Admin Site**:
- Pages/services: `admin/src/app/**`
- Internal-only tooling and moderation interfaces
- **Design system: Live First** — read the `live-first` skill (section "Admin site") before any admin UI work; tokens + shared primitives in `admin/src/styles.css`

**Documentation**:
- MDX content: `dimadocs/src/content/docs/**/*.mdx`
- Config + styling: `dimadocs/astro.config.mjs`, `dimadocs/src/styles/`

**Twitch Extension**:
- Extension server: `dimafx/server/src/**`
- Extension UI (panel/config): `dimafx/panel.html`, `dimafx/config.html`, `dimafx/*.css`, `dimafx/*.js`

## Cron Workers Architecture (Important)

`dimabot` runs a **single cron host process** inside the `dima-cron` container. The entrypoint is:

```
dimabot/src/workers/cron.index.ts  →  dist/workers/cron.index.js
```

### How It Works

- `cron.index.ts` is a lightweight supervisor.
- It starts all registered workers, monitors them, and **self-heals** by restarting only the failed worker (not the entire process).
- Workers run in the **background**, outside the main Twitch message loop.

Redeploying the `cron` target replaces the `dima-cron` container and restarts its entire process tree once, including all worker children. Worker-level recovery still restarts only the failed child. A cron release does not replace unrelated Compose services or containers; do not promise that unrelated cron worker PIDs survive a release.

### When to Create a Worker

Create a new `*.worker.ts` when the task meets **any** of these criteria:

- It runs on a schedule (periodic, not per-message).
- It performs heavy or blocking work that would add **100–200 ms+ latency** to chat responses if run inline (e.g., embedding generation, large DB migrations, external API calls with variable latency).
- It must survive bot restarts or be retried independently.
- It needs its own isolated error handling and restart policy.

**Examples of current workers**:
- `follow_ledger.worker.ts` – maintains follow relationship ledger
- `stream_analytics.worker.ts` – aggregates stream metrics
- `stream_memory.worker.ts` – processes chat memory embeddings (heavy; would block message handler)
- `follow_defense.worker.ts` – raid/follow attack detection
- `temporary_roles.worker.ts` – expires temporary moderator/VIP roles
- `timer.worker.ts` – command timers and countdowns
- `activation-reminder.worker.ts` – email activation reminders

### How to Add a New Worker

1. Create `dimabot/src/workers/your-feature.worker.ts`
2. Export a worker object with `name`, `schedule` (cron expression), and `run()` function.
3. Register it in the `WORKERS` array inside `dimabot/src/workers/cron.index.ts`.
4. The supervisor will automatically start, monitor, and heal it.

### Scheduling and pacing review for worker migrations

Before freezing a TypeScript-to-Rust or other worker migration, inventory every loop sleep, per-item delay, batch cooldown, polling interval, retry backoff, and lease wait in the source and candidate. Discuss each pause with the user in the context of the requested migration: state what it protects, whether work is ready or future-due, and decide to keep, remove, or change it before source freeze. This is part of the migration review, not a new approval gate or reconfirmation requirement for changes the user has already authorized.

Document the reason for each retained wait. Keep batches bounded and scheduling fair; yield between units or batches where needed. Preserve waits for genuinely future-due work, real external rate limits, retry/backoff after errors, lease coordination, watchdog recovery, and orderly signal/shutdown behavior. Do not sleep while ready work remains merely to create an artificial cadence. Prove both idle/future-work waiting and continued progress with a normal-mode backlog test that checks readiness and per-pass counts, so an empty or full count is not mistaken for ready work. Record these decisions and the backlog evidence in the migration note.

**Do not** split cron work into separate containers unless resource isolation is explicitly required.

## Frontend Architecture Notes (dimasite)

- Modern Angular v21: standalone components (default), signals, `input()`/`output()` functions, `computed()`, `inject()`.
- Signal-based i18n via `LanguageService` (no external libs).
- Authenticated routes use `AuthenticatedLayoutComponent` + child routes under `/:streamer`.
- Guards: `authenticatedGuard`, `dashboardAccessGuard`, `streamerRouteShapeGuard` (uses `MODULE_CHILDREN` whitelist).
- Theme via `ThemeService` (light/dark/system) + `data-theme` attribute.

### Frontend Deploy (no container rebuild needed)

After validating a requested change to `dimasite/src/**`, use the agent helper from the repository root:

```bash
scripts/saas-ops build site
# Use the exact run ID printed by build and a check for the changed behavior:
scripts/saas-ops verify site-<run-id> --check <behavior-script>
scripts/saas-ops deploy site-<run-id>
```

The `dimabot-site` nginx container bind-mounts `dimasite/dist/dimasite/browser/` directly to `/usr/share/nginx/html`. A direct `npm run build --prefix dimasite` would write into that live mount; agents use the helper's isolated build and verified publication instead. No container restart is needed. Full details in `dimasite/AGENTS.md` → "Production Build & Deployment".

**Hybrid rendering**: the build prerenders `/` (output `browser/index.html`) and emits `browser/index.csr.html` as the CSR fallback for all app routes. Render modes live in `dimasite/src/app/app.routes.server.ts`. The nginx fallback on the prod host must target `index.csr.html` (see `dimasite/AGENTS.md` → "Required nginx routing rule").

- Plan-tier styling: use `plan_tier` (`free|premium|pro`) as source of truth. Premium = subtle gold, Pro = stronger gold treatment.
- **Responsive priority**: All site projects (`dimasite/`, `admin/`, `dimadocs/`) follow a **mobile-first** approach. Design for 320–480px base, then enhance for tablet/desktop. Use `min-width` media queries. Test on real mobile devices or emulation before finalizing desktop.
- **Theme priority: dark mode first**: Dark mode is a first-class citizen and the priority theme for all UI surfaces (`dimasite/`, `admin/`, `dimadocs/`, `dimafx/`). Design, review and polish in dark first; light mode must still be correct and AA-compliant, but dark is the reference look. Every visual check covers both themes, starting with dark. (DimaFX still follows the theme Twitch reports.)
- **Visual verification**: When checking frontend design or layout, agents may use Playwright through its MCP tools or CLI to inspect the running application at desktop and mobile viewports.

## Styling Policy (Updated – Hybrid Approach)

**Goal**: Keep global `styles.css` focused on design tokens and truly shared concerns while allowing substantial component/page styles to live in their own files.

**Rules**:

1. **Global `styles.css`** – Only:
   - Design tokens (CSS custom properties)
   - Theme variables (light/dark)
   - Global resets, typography, layout primitives
   - Shared utility classes used across many components
   - Plan-tier styling hooks

2. **Component `*.component.css`** – Encouraged for:
   - Page-level layouts and sections
   - Complex reusable components (modals, tables, dashboards)
   - Any styling that would make `styles.css` grow beyond ~3–4k lines of core tokens

3. **Budget awareness**:
   - Angular `anyComponentStyle` budget: 50 kB warning / 100 kB error.
   - If a single component stylesheet exceeds ~800–1000 lines, consider extracting shared pieces into a global partial or a dedicated `shared/` stylesheet.

4. **Migration note**: Large existing component stylesheets (triggers, dimafx, follow-defense, etc.) may remain in place. New work should prefer component-scoped files unless the styles are genuinely global.

## API Contracts – How to Stay Current

**Do not** rely on static documentation in this file for endpoint shapes.

- All HTTP routes are defined in `dimabot/src/server/routes/*.route.ts`.
- Route mounting and middleware order live in `dimabot/src/server/server.ts`.
- WebSocket contracts are in `dimabot/src/server/websocket.ts`.

**Always read the source** for the most up-to-date request/response shapes, authentication requirements, and error formats. The envelope convention `{ error, message, status, data }` is used across most endpoints.

## Per-Project Agent Guides

Each major project now contains its own `AGENTS.md` for domain-specific rules:

- `dimasite/AGENTS.md` – Angular patterns, design system, component guidelines, styling details, hybrid CSS policy.
- `dimabot/AGENTS.md` – Backend architecture, command patterns, worker guidelines, API entry points.
- `admin/AGENTS.md` – Internal admin panel patterns and access control.
- `dimadocs/AGENTS.md` – Astro + MDX documentation authoring guidelines.
- `dimafx/AGENTS.md` – Twitch Extension client/server patterns.
- `dimadb/AGENTS.md` – Internal DB console (single Node container, Angular CSR).
- `dima-analytics/AGENTS.md` – Private analytics service, data scopes, retention, and first-install workflow.
- `dima-rust/AGENTS.md` – Rust library and native cron worker boundaries, capped build policy, dependency usage, and verification commands.

Root rules in this file always take precedence. Project-specific files add detail, never contradict.

## Agent Commit Policy (Important)

When an agent makes file changes that should be tracked in git history, it **must** create a commit. The commit message must clearly identify:

- **Who performed the work** (model name or harness):
  - `MiniMax M3`, `Grok 4.3`, `Grok Build 0.1`, `Claude 4`, `GPT-5.5`, etc.
- **Which harness / CLI** was used (when applicable):
  - `opencode`, `grok-build`, `antigravity`, `claude-code`, etc.

### Commit Message Format

```
<type>: <short summary>

<optional body explaining the change>

Agent: <Model Name> via <Harness>
```

### Examples

```
feat(dimasite): add plan-tier gold accents to dashboard cards

- Applied subtle gold border/glow for premium users
- Stronger gold treatment for pro users
- Uses data-plan-tier attribute hook for reusability

Agent: Grok 4.3 via opencode
```

```
chore(dimabot): register stream_memory.worker in cron supervisor

- Worker now handles embedding generation outside message loop
- Prevents 100-200ms+ latency on chat responses

Agent: MiniMax M3 via antigravity
```

```
fix(admin): tighten admin-auth.guard to check whitelist on every request

Agent: Claude 4 via claude-code
```

### Rules

- **Verification required before commit**: An agent **must not** create a commit unless the changes have been verified to compile and run without errors introduced by *their own work*.
  - Follow the production workflow above: use isolated builds/runtime checks before deployment. For changes limited to repository guidance, review the diff, validate referenced paths/commands, and run `git diff --check`; application builds and runtime checks are unnecessary. Published documentation-site content still requires its preview/build/deploy checks.
  - If the project has tests, at minimum ensure the changed code paths do not introduce new failures.
- **Multi-agent concurrent work**: When two or more agents are editing the codebase simultaneously and one agent's incomplete changes cause build errors for another:
  - The committing agent should first attempt to verify their changes in a separate worktree/copy. Never stash, reset, overwrite, or commit another contributor's unrelated changes. Do not deploy their incomplete work as part of your task.
  - If verification is impossible due to the other agent's work, the commit message **must** explicitly note the known issue and attribute it to the other agent (e.g., "Build currently fails due to parallel work by Grok 4.3 on X feature – will be resolved once that PR lands").
  - Never commit broken code and blame "the other agent" without clear documentation.
- Always commit when the change is complete and verified (or the multi-agent exception is documented).
- Never leave uncommitted work that belongs in the monorepo history.
- If multiple agents collaborate on a single task, list all contributors in the message.
- Use conventional commit types (`feat`, `fix`, `chore`, `docs`, `refactor`, `test`, `perf`).

---

**This document is the single source of truth for agent navigation across the monorepo.** Update it when project structure or cross-cutting policies change. Project-level `AGENTS.md` files handle domain depth.
