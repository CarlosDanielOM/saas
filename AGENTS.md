# SaaS Workspace Agent Guide

**This is the root navigation document for the entire monorepo.** All agents must read this file first.

## Monorepo Structure

This workspace is a **single git repository** (`saas/`) containing five related projects. There are no nested `.git` folders. All agents work from the `saas/` root.

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

After **any** change to `dimasite/src/**`, rebuild from the repo root:

```bash
npm run build --prefix dimasite
```

The `dimabot-site` nginx container bind-mounts `dimasite/dist/dimasite/browser/` directly to `/usr/share/nginx/html`. nginx reads files per-request, so the new bundle is live the moment the build finishes — no `cp`, no container restart. Full details in `dimasite/AGENTS.md` → "Production Build & Deployment".

- Plan-tier styling: use `plan_tier` (`free|premium|pro`) as source of truth. Premium = subtle gold, Pro = stronger gold treatment.
- **Responsive priority**: All site projects (`dimasite/`, `admin/`, `dimadocs/`) follow a **mobile-first** approach. Design for 320–480px base, then enhance for tablet/desktop. Use `min-width` media queries. Test on real mobile devices or emulation before finalizing desktop.

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

## GitNexus MCP

This project is indexed by GitNexus as **saas**.

### Always Start Here

1. Read `gitnexus://repo/{name}/context` — codebase overview + check index freshness.
2. Match your task to a skill below and read that skill file.
3. Follow the skill's workflow and checklist.

> If step 1 warns the index is stale, run `npx gitnexus analyze` first.

### Skills

| Task                              | Read this skill file                                      |
|-----------------------------------|-----------------------------------------------------------|
| Understand architecture           | `.claude/skills/gitnexus/gitnexus-exploring/SKILL.md`     |
| Blast radius / impact analysis    | `.claude/skills/gitnexus/gitnexus-impact-analysis/SKILL.md` |
| Trace bugs                        | `.claude/skills/gitnexus/gitnexus-debugging/SKILL.md`     |
| Rename / extract / refactor       | `.claude/skills/gitnexus/gitnexus-refactoring/SKILL.md`   |
| Tools, resources, schema          | `.claude/skills/gitnexus/gitnexus-guide/SKILL.md`         |
| Index / status / clean / wiki     | `.claude/skills/gitnexus/gitnexus-cli/SKILL.md`           |

## Per-Project Agent Guides

Each major project now contains its own `AGENTS.md` for domain-specific rules:

- `dimasite/AGENTS.md` – Angular patterns, design system, component guidelines, styling details, hybrid CSS policy.
- `dimabot/AGENTS.md` – Backend architecture, command patterns, worker guidelines, API entry points.
- `admin/AGENTS.md` – Internal admin panel patterns and access control.
- `dimadocs/AGENTS.md` – Astro + MDX documentation authoring guidelines.
- `dimafx/AGENTS.md` – Twitch Extension client/server patterns.

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
  - Run the appropriate build/type-check command for the project (e.g., `npm run build`, `tsc --noEmit`, `ng build --configuration=production`).
  - If the project has tests, at minimum ensure the changed code paths do not introduce new failures.
- **Multi-agent concurrent work**: When two or more agents are editing the codebase simultaneously and one agent's incomplete changes cause build errors for another:
  - The committing agent should first attempt to verify their changes in isolation (e.g., by temporarily stashing the other agent's uncommitted files).
  - If verification is impossible due to the other agent's work, the commit message **must** explicitly note the known issue and attribute it to the other agent (e.g., "Build currently fails due to parallel work by Grok 4.3 on X feature – will be resolved once that PR lands").
  - Never commit broken code and blame "the other agent" without clear documentation.
- Always commit when the change is complete and verified (or the multi-agent exception is documented).
- Never leave uncommitted work that belongs in the monorepo history.
- If multiple agents collaborate on a single task, list all contributors in the message.
- Use conventional commit types (`feat`, `fix`, `chore`, `docs`, `refactor`, `test`, `perf`).

---

**This document is the single source of truth for agent navigation across the monorepo.** Update it when project structure or cross-cutting policies change. Project-level `AGENTS.md` files handle domain depth.