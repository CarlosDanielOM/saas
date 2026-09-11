# SaaS Workspace Agent Guide

**This is the root navigation document for the entire monorepo.** All agents must read this file first.

## Production Host & Delivery Workflow

**This checkout, `/root/saas`, is on the actual production server.** Docker and live services are available here. Do not assume this is a development-only machine or that Docker is unavailable. Confirm current container mounts and Compose ownership before acting; the paths below describe this host.

**A request to implement a change authorizes the complete delivery workflow: edit, validate in isolation, clean up temporary resources, deploy the affected services, and verify production.** Proceed without asking again for routine builds or targeted deployment after validation passes. Respect narrower requests such as review-only, plan-only, or do-not-deploy. Destructive data changes or infrastructure changes outside the requested scope require separate authorization.

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

The static sites have their own Compose files in their project directories. Nginx Proxy Manager fronts them; it does not own their Compose lifecycle. Content updates do not require nginx restarts. Nginx configuration changes require validation and a targeted reload.

Changes limited to repository guidance (such as `AGENTS.md` or architecture Markdown) require documentation checks, not application builds, test containers, or deployment. Published documentation-site content still follows the `dimadocs` preview/build/deploy workflow. In the final report, state what was verified, what was deployed, and any unresolved limitations.

## Monorepo Structure

This workspace is a **single git repository** (`saas/`) containing six related projects. There are no nested `.git` folders. Run repository operations from the relevant checkout root; use isolated worktrees/copies when required by the production workflow above.

- Each subproject manages its own `package.json` and `package-lock.json`.
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

**Rule**: When asked to make a change, first identify which project owns the feature, then read that project's `AGENTS.md` (if present) before editing.

## Where to Edit – Quick Reference

**Backend (dimabot)**:
- HTTP routes: `dimabot/src/server/routes/*.route.ts`
- Route registration: `dimabot/src/server/server.ts`
- WebSocket events/contracts: `dimabot/src/server/websocket.ts`
- Bot commands/handlers: `dimabot/src/commands/**`, `dimabot/src/handlers/**`, `dimabot/src/functions/**`
- Cron workers: `dimabot/src/workers/*.worker.ts` (register in `cron.index.ts`)

**Frontend (dimasite)**:
- Pages/components/services: `dimasite/src/app/**`
- **Design system: Live First (OC3c)** — agents must read `.opencode/skills/live-first/SKILL.md` (or `.claude/skills/live-first/SKILL.md`) before any dimasite UI work
- Production references: landing `/`, tip `/tip/:streamer`, dashboard `/:streamer/dashboard`, auth layout
- Global design tokens + shared utilities: `dimasite/src/styles.css`
- Component-scoped styles: `*.component.css` (encouraged for page-level or reusable blocks)
- Route guards: `dimasite/src/app/guards/**`
- i18n: `dimasite/src/assets/i18n/{en,es}.json`

**Admin Site**:
- Pages/services: `admin/src/app/**`
- Internal-only tooling and moderation interfaces

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
