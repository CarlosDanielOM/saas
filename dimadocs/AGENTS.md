# dimadocs Agent Guide

**This document supplements the root `saas/AGENTS.md`.** Read the root file first for monorepo rules.

## Project Purpose

`dimadocs/` is the public documentation site built with Astro + MDX. It hosts user-facing guides for commands, triggers, follow-defense, AI personality, TTS, rewards, dashboard, and getting-started flows (both English and Spanish).

## Key Entry Points

- `astro.config.mjs` – Astro configuration and integrations
- `src/content/docs/` – MDX documentation files (English)
- `src/content/docs/es/` – Spanish translations
- `src/content.config.ts` – Content collection schema

## Architecture Notes

- Astro generates static HTML at build time.
- MDX files support components, frontmatter, and custom styling.
- Keep documentation in sync with actual feature behavior in `dimabot/` and `dimasite/`.
- Use the shared logo assets and i18n strings from `src/assets/`.

## Responsive Design Priority

- **Mobile-first approach**: Design and implement for the smallest viewport first (320px–480px base).
- Progressively enhance for tablet (768px+) and desktop (1024px+) breakpoints.
- Prefer `min-width` media queries over `max-width` (mobile-first).
- Always test layouts on real mobile devices or mobile emulation before considering desktop complete.

## Content Guidelines

- Write clear, concise, user-focused copy.
- Include code examples where helpful.
- Maintain both English and Spanish versions for all new pages.
- Update screenshots or examples when UI/UX changes.

## Machine-readable documentation

- `src/pages/[...document].txt.ts` generates `/llms.txt`, `/es/llms.txt`, per-language `llms-full.txt`, and an `index.txt` Markdown version under every published page. Text files use the existing nginx `text/plain` MIME mapping.
- These exports use the content collection, exclude drafts, preserve code examples/tables, and rewrite internal documentation links to absolute text URLs. Do not maintain separate copied reference documents.
- `src/lib/markdown.mjs` converts MDX components to Markdown. Add an explicit adapter when introducing a new component or dynamic expression; unsupported content fails generation instead of silently disappearing.
- `DocsHead.astro` and `DocsFooter.astro` expose the index and each page's text alternative. Keep the AI assistant guide in both languages.
- Run `npm test --prefix dimadocs` for export fidelity, then use `ops/checks/docs_llms.py` with the delivery helper to verify the candidate's indexes, pages, links, code, discovery metadata, and sitemap.
- See `CRAWLER_ACCESS.md` for the observed Cloudflare automated-client block and the pending docs-only configuration rule. Passing content checks does not establish access for all AI providers.

## Styling — Live First (docs)

Docs share the **Live First (OC3c)** design language with `dimasite/`.

- Global theme: `src/styles/custom.css` (tokens + Starlight overrides only).
- Tokens: `--bg`, `--tile`, `--fg`, `--muted`, `--line`, `--accent`, `--accent-soft`, `--kicker`, `--live`, `--radius`, `--shadow`, `--font` (Plus Jakarta Sans).
- Patterns: bento tiles (`.lf-tile`), kickers, pill buttons — **not** glassmorphism / aurora shells.
- Homepage splash markup uses `.lf-docs` / `.lf-hero` / `.lf-bento` / `.lf-feature`.
- Dark/light via Starlight `data-theme`; both themes must stay readable (4.5:1 body text).
- Reference: `.opencode/skills/live-first/SKILL.md` and dimasite landing/dashboard.

## Layout & navigation

- Sidebar (`astro.config.mjs`) is grouped by streamer task: Start here, Chat & commands, Alerts/sound/overlays, Channel points, AI features, Safety, Growth & stats, Help. Add new pages to the group a streamer would look in; mark Alpha/plan-gated pages with a sidebar `badge` (`{ en, es }` text).
- `DocsPageTitle.astro` shows each page's frontmatter `description` as a lead line under the title — write it as one plain sentence saying what the page helps with.
- Homepage (`index.mdx`, `es/index.mdx`): search-first hero (`DocsHomeSearch.astro`), 3-step start, topic tiles mirroring the sidebar groups. Keep both languages in sync. The wrapper has `.not-content` so Starlight's markdown spacing doesn't leak in.
- Interactive-only components (`DocsHomeSearch`, `Icon`) are dropped by the text exporter in `src/lib/markdown.mjs`; register any new one there.

## Docs assistant and living mascot

`DocsAssistant.astro` (mounted on every page by `DocsPageFrame.astro`) keeps the existing chat panel and adds a page-local mascot launcher. The launcher rests at the page edge; the mascot only travels through the page when the reader explicitly starts “Show me this page” or follows a same-page citation. `DocsMascot.astro`, `MascotFigure.astro`, `src/lib/docs-mascot.mjs`, `src/lib/docs-mascot-guide.mjs`, and `src/styles/docs-mascot.css` implement the mascot and guide. Keep English and Spanish labels in sync.

The guide uses visible `h2` headings inside the article's `.sl-markdown-content`, falling back to the visible `h1` when there are no sections. Citation guidance accepts only a same-origin URL on the current document with the same path and query and a real visible target inside `main`; external and cross-page citations navigate normally. Each stop places a separate stage after the Starlight heading wrapper, then offers Next/Done; Escape ends the guide when no dialog is open. The assistant dialog remains the same chat/search entry point. Ordinary dialog close restores focus to its launcher, while a guide puts focus on its controls. The mascot pauses when hidden, offscreen, user-paused, or when reduced motion is requested; the user's pause choice persists in `localStorage` as `docs-mascot:motion` (`paused` or `on`).

The mascot is presentation layered over existing assistant behavior: keep the public assistant route, SSE events, response sources, feedback, history, docs search, and hooks compatible. `POST https://api.domdimabot.com/docs-assistant/ask` (dimabot `src/server/routes/docs-assistant.route.ts`) remains the answer endpoint, grounded in this site's `llms-full.txt` export. The request carries `{ messages, page }`; SSE emits `start {id}`, `status {phase: thinking|searching|testing}`, `text {delta}`, `reset {}`, `done {id, sources: [{title, url}], stopReason}`, or `error {code}`. Pre-stream failures remain JSON error envelopes. `POST /docs-assistant/feedback` accepts `{id, helpful}`. The conversation remains per-language in `sessionStorage` under `docs-assistant:v1:<lang>`. Existing integration points remain: cancelable `docs-assistant:ask` with `{ question, page: { title, url, lang }, mount }`, `window.DocsAssistant.open(question?)` / `.close()`, `[data-docs-assistant-open]`, and `[data-docs-search="query"]`.

For local previews only, `localStorage['docs-assistant:api']` can point the assistant at a fixture API; the override is ignored off `localhost` and `127.0.0.1`. `ops/checks/docs_mascot.py` serves a loopback SSE fixture and waits for an actual browser assertion receipt at `/__finish`; it makes no live model/API calls. Exact-candidate verification allows 240 seconds inside the helper's 300-second check timeout. Its `--fixture-only` mode supports longer development-preview runs. The helper also runs `ops/checks/docs_visuals.py`; the standard docs harness includes `ops/checks/docs_llms.py`. Keep this assistant guide in both language exports.

- Answers render through `src/lib/assistant-markdown.mjs` (escape-first Markdown; docs links become same-site paths). Tests: `tests/assistant-markdown.test.mjs`.
- While the assistant looks up functions or tests a command, the panel shows "Checking the function list…" / "Testing the command…" (`status` events with `phase`); a `reset` event clears a preamble the server retracted.
- Each answer shows "Pages used" chips, copy buttons on code, and 👍/👎 feedback. Errors offer Retry and the docs search. The conversation is kept per language in `sessionStorage`, so following a cited page keeps it.
- The model links pages inline using the "Source:" URLs in the export, so keep every page's frontmatter title/description accurate; that's what the assistant cites.
- Local previews: on `localhost`/`127.0.0.1` only, `localStorage['docs-assistant:api']` points the panel at a test API (production ignores it). `ops/checks/docs-redesign-browser.mjs` uses this with a fake API.
- Replacing the built-in chat is still possible: a `docs-assistant:ask` listener that calls `event.preventDefault()` takes over (`event.detail` = `{ question, page: { title, url, lang }, mount }`). Also available: `window.DocsAssistant.open(question?)` / `.close()`, `[data-docs-assistant-open]`, and `[data-docs-search="query"]`.

## Production Verification & Deployment

- Use `scripts/saas-ops` target `docs` and [`../ops/README.md`](../ops/README.md). `scripts/dima-update` is the human operator's tool; agents must not invoke or modify it.
- Preview with `scripts/saas-ops preview docs --port 4322` from the repository root. Check changed pages, links, affected languages, and mobile/desktop layouts; Ctrl-C stops and removes the isolated preview.
- Run `scripts/saas-ops build docs`, then use the exact generated run ID with `verify docs-<run-id> --check <behavior-script>`, `deploy docs-<run-id>`, and `cleanup docs-<run-id>` through the same helper. Build output stays outside the live mount until verified publication to `dimadocs/dist/`.
- The helper preserves a rollback bundle and verifies served entrypoints. Check changed live pages/links too; use `rollback docs-<run-id>` for a regression. No nginx restart is needed for content changes.
- `dimadocs/docker-compose.yml` owns the service. Validate nginx config changes in isolation before applying, then run `nginx -t` and reload only the affected production nginx process.

---

**This file is intentionally lightweight.** Add MDX authoring guidelines or content-structure notes here as the documentation grows. Root rules always take precedence.
