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

## Code Intelligence: GitNexus + Graphify

This project has **two complementary knowledge graph tools**. They overlap on static code structure but each has unique strengths. Use the right one for the task.

### Quick decision guide

| Task | Use | Why |
|------|-----|-----|
| "What breaks if I change X?" | **GitNexus** `impact()` | Blast radius analysis — finds all callers/importers |
| "Show me the full context of symbol X" | **GitNexus** `context()` | 360° view: callers, callees, process participation |
| "Trace the call path from A to B" | **GitNexus** `trace()` | Shortest directed path over call + class-member edges |
| "What depends on this route?" | **GitNexus** `api_impact()` | Route-level consumer mapping + response shape checks |
| "Check my uncommitted changes" | **GitNexus** `detect_changes()` | Maps git diff hunks to symbols + affected flows |
| "Rename X across the codebase" | **GitNexus** `rename()` | Graph-aware rename with confidence tags |
| "Raw Cypher query on the graph" | **GitNexus** `cypher()` | Direct DB query on LadybugDB |
| "How does the codebase work as a whole?" | **Graphify** `GRAPH_REPORT.md` | God nodes, communities, surprising connections |
| "What concepts connect auth to the database?" | **Graphify** `query` | Semantic concept traversal (includes docs, not just code) |
| "What's the relationship between A and B?" | **Graphify** `path "A" "B"` | Edge-level detail with relation type + confidence |
| "Explain what X does in plain language" | **Graphify** `explain "X"` | Node + neighbors summary |
| "Show me import cycles / surprising cross-file links" | **Graphify** `GRAPH_REPORT.md` | Auto-detected cycles, god nodes, hyperedges |
| "Find design docs that reference this code" | **Graphify** | LLM-extracted doc→code traces (GitNexus can't do this) |
| "Interactive graph visualization" | **Graphify** `graph.html` | Clickable network graph (when < 5000 nodes) |

### How they complement each other

**GitNexus** is the **real-time code intelligence layer**:
- Persistent LadybugDB graph database (queryable via Cypher)
- MCP server with 8 live tools (impact, context, trace, query, rename, detect_changes, etc.)
- Hybrid BM25 + vector semantic search (8,219 embeddings, snowflake-arctic-embed-xs)
- Incremental re-index on every commit (post-commit hook, ~seconds, free)
- Sees: symbols, types, imports, calls, class hierarchies, route handlers, execution flows
- Blind spots: dynamic imports, barrel-file re-exports, callback patterns, design intent, documentation

**Graphify** is the **architecture + design-intent layer**:
- NetworkX graph stored as `graph.json` (portable, committed to git)
- LLM-driven semantic extraction (MiniMax M3, 512K token budget, reasoning_split)
- 290 LLM-labeled communities with descriptive names
- God nodes, surprising connections, import cycles, hyperedges
- Multi-modal: reads code (Tree-sitter), docs (Markdown/MDX), images (M3 vision)
- AST-only rebuild on every commit (post-commit hook, free); LLM extraction on-demand
- Sees: code structure + documentation concepts + design rationale + image/diagram content
- Blind spots: real-time querying (no MCP server by default), blast radius, rename safety

### When to use which — by workflow phase

**Before editing code:**
1. `gitnexus impact({target: "symbolName", direction: "upstream"})` — check blast radius
2. `gitnexus context({name: "symbolName"})` — understand callers/callees
3. If the symbol is part of a larger architecture question, `graphify explain "concept"` for design context

**Exploring unfamiliar code:**
1. `graphify query "how does X work"` — get the concept-level overview first (includes docs)
2. `gitnexus query({search_query: "X"})` — get process-grouped execution flows
3. `gitnexus context({name: "specificSymbol"})` — drill into a specific symbol

**Before committing:**
1. `gitnexus detect_changes()` — verify changes only affect expected symbols/flows
2. Check the Graphify LLM Re-Extraction Policy (below) — assess if semantic refresh is needed

**Architecture review / onboarding:**
1. Read `graphify-out/GRAPH_REPORT.md` — god nodes, communities, surprising connections
2. `graphify query "what are the core abstractions?"` — semantic overview
3. `gitnexus query({search_query: "main entry points"})` — execution flow traces

### Index freshness — both auto-update

| Tool | Post-commit hook | What it updates | Cost |
|------|-----------------|-----------------|------|
| GitNexus | `gitnexus analyze .` (background) | Full graph: symbols, edges, embeddings (incremental) | Free |
| Graphify | AST rebuild (background) | Code structure only: nodes, edges, communities | Free |
| Graphify LLM | Manual or agent-triggered | Community labels, doc concepts, image understanding | MiniMax tokens ($0 on plan) |

Both hooks are in `.git/hooks/post-commit` and run automatically. Neither blocks the commit.

### Current index stats

| Metric | GitNexus (v1.6.8) | Graphify (v0.8.47) |
|--------|-------------------|---------------------|
| Storage | `.gitnexus/lbug` (LadybugDB, ~120 MB) | `graphify-out/graph.json` (NetworkX, ~6 MB) |
| Nodes | 9,380 | 5,455 |
| Edges | 23,286 | 11,450 |
| Communities | 535 clusters | 290 LLM-labeled communities |
| Execution flows | 300 processes | — |
| Embeddings | 8,219 (384-dim, HNSW index) | — |
| Search | Hybrid BM25 + vector | BFS subgraph traversal |
| LLM extraction | — | MiniMax M3 (reasoning_split, 512K tokens) |

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

<!-- gitnexus:start -->
# GitNexus — Code Intelligence

This project is indexed by GitNexus as **saas** (9583 symbols, 23488 relationships, 300 execution flows). Use the GitNexus MCP tools to understand code, assess impact, and navigate safely.

> Index stale? Run `node .gitnexus/run.cjs analyze` from the project root — it auto-selects an available runner. No `.gitnexus/run.cjs` yet? `npx gitnexus analyze` (npm 11 crash → `npm i -g gitnexus`; #1939).

## Always Do

- **MUST run impact analysis before editing any symbol.** Before modifying a function, class, or method, run `impact({target: "symbolName", direction: "upstream"})` and report the blast radius (direct callers, affected processes, risk level) to the user.
- **MUST run `detect_changes()` before committing** to verify your changes only affect expected symbols and execution flows. For regression review, compare against the default branch: `detect_changes({scope: "compare", base_ref: "main"})`.
- **MUST warn the user** if impact analysis returns HIGH or CRITICAL risk before proceeding with edits.
- When exploring unfamiliar code, use `query({search_query: "concept"})` to find execution flows instead of grepping. It returns process-grouped results ranked by relevance.
- When you need full context on a specific symbol — callers, callees, which execution flows it participates in — use `context({name: "symbolName"})`.
- For security review, `explain({target: "fileOrSymbol"})` lists taint findings (source→sink flows; needs `analyze --pdg`).

## Never Do

- NEVER edit a function, class, or method without first running `impact` on it.
- NEVER ignore HIGH or CRITICAL risk warnings from impact analysis.
- NEVER rename symbols with find-and-replace — use `rename` which understands the call graph.
- NEVER commit changes without running `detect_changes()` to check affected scope.

## Resources

| Resource | Use for |
|----------|---------|
| `gitnexus://repo/saas/context` | Codebase overview, check index freshness |
| `gitnexus://repo/saas/clusters` | All functional areas |
| `gitnexus://repo/saas/processes` | All execution flows |
| `gitnexus://repo/saas/process/{name}` | Step-by-step execution trace |

## CLI

| Task | Read this skill file |
|------|---------------------|
| Understand architecture / "How does X work?" | `.claude/skills/gitnexus/gitnexus-exploring/SKILL.md` |
| Blast radius / "What breaks if I change X?" | `.claude/skills/gitnexus/gitnexus-impact-analysis/SKILL.md` |
| Trace bugs / "Why is X failing?" | `.claude/skills/gitnexus/gitnexus-debugging/SKILL.md` |
| Rename / extract / split / refactor | `.claude/skills/gitnexus/gitnexus-refactoring/SKILL.md` |
| Tools, resources, schema reference | `.claude/skills/gitnexus/gitnexus-guide/SKILL.md` |
| Index, status, clean, wiki CLI commands | `.claude/skills/gitnexus/gitnexus-cli/SKILL.md` |

<!-- gitnexus:end -->

## graphify

This project has a knowledge graph at graphify-out/ with god nodes, community structure, and cross-file relationships.

When the user types `/graphify`, invoke the `skill` tool with `skill: "graphify"` before doing anything else.

Rules:
- For codebase questions, first run `graphify query "<question>"` when graphify-out/graph.json exists. Use `graphify path "<A>" "<B>"` for relationships and `graphify explain "<concept>"` for focused concepts. These return a scoped subgraph, usually much smaller than GRAPH_REPORT.md or raw grep output.
- Dirty graphify-out/ files are expected after hooks or incremental updates; dirty graph files are not a reason to skip graphify. Only skip graphify if the task is about stale or incorrect graph output, or the user explicitly says not to use it.
- If graphify-out/wiki/index.md exists, use it for broad navigation instead of raw source browsing.
- Read graphify-out/GRAPH_REPORT.md only for broad architecture review or when query/path/explain do not surface enough context.
- After modifying code, run `graphify update .` to keep the graph current (AST-only, no API cost).

### Graphify LLM Re-Extraction Policy

The post-commit git hook automatically rebuilds the **AST graph** (code structure) for free after every commit using Tree-sitter — no LLM calls needed. This keeps `graph.json` and `GRAPH_REPORT.md` structurally fresh.

However, the **LLM-driven semantic extraction** (community labels, doc-to-code concept relationships, image understanding, surprising connections) is NOT re-run automatically because it costs MiniMax M3 tokens and takes ~4 minutes. This extraction only needs to run when the *meaning* of the codebase changes, not just the structure.

**Agent responsibility — assess and act:**

After completing a work session (especially before committing), the agent should assess whether the changes warrant an LLM re-extraction. Use this criteria:

| Trigger | Action |
|---------|--------|
| **Minor changes** (bug fixes, small refactors, config tweaks, 1-3 files) | Do nothing. AST-only rebuild is sufficient. |
| **Moderate changes** (new features, 4-15 files, new routes/components) | **Notify the user**: "These changes are significant enough that the Graphify semantic graph (community labels, doc relationships) may be stale. Run `graphify extract . --update --backend minimax` when convenient to refresh the LLM-extracted layer." |
| **Major changes** (new subsystem, 15+ files, new worker/module, architectural shift, docs added/changed) | **Run it yourself** if: (1) the build/type-check passes, (2) no known bugs from your work, (3) you're confident the changes are stable. Use: `MINIMAX_API_KEY=<key> graphify extract . --update --backend minimax` then `graphify cluster-only . --backend minimax`. If any of those conditions are NOT met, **notify the user instead** and explain what's blocking. |
| **Documentation changes** (`.mdx`, `.md`, planning docs, images) | **Always notify**: "Documentation/images changed — Graphify's LLM layer needs a manual refresh to pick up new concepts. Run `graphify extract . --update --backend minimax` when ready." |

**How to run the LLM re-extraction:**

```bash
# Re-extract only changed files (incremental, fast for small changes):
MINIMAX_API_KEY=sk-cp-... graphify extract . --update --backend minimax

# Then re-label communities (if community structure shifted):
MINIMAX_API_KEY=sk-cp-... graphify cluster-only . --backend minimax
```

**The MiniMax M3 config** (512K max tokens, reasoning_split) is stored in `~/.graphify/providers.json`. The API key is in `~/.config/opencode/opencode.json` under `mcp.minimax.environment.MINIMAX_API_KEY`.

**Do NOT** run LLM re-extraction on every commit. The AST hook handles structural freshness. Only trigger the LLM layer when meaning changes, not just structure.
