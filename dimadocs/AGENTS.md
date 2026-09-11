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

## Styling — Live First (docs)

Docs share the **Live First (OC3c)** design language with `dimasite/`.

- Global theme: `src/styles/custom.css` (tokens + Starlight overrides only).
- Tokens: `--bg`, `--tile`, `--fg`, `--muted`, `--line`, `--accent`, `--accent-soft`, `--kicker`, `--live`, `--radius`, `--shadow`, `--font` (Plus Jakarta Sans).
- Patterns: bento tiles (`.lf-tile`), kickers, pill buttons — **not** glassmorphism / aurora shells.
- Homepage splash markup uses `.lf-docs` / `.lf-hero` / `.lf-bento` / `.lf-feature`.
- Dark/light via Starlight `data-theme`; both themes must stay readable (4.5:1 body text).
- Reference: `.opencode/skills/live-first/SKILL.md` and dimasite landing/dashboard.

## Production Verification & Deployment

- Use `scripts/saas-ops` target `docs` and [`../ops/README.md`](../ops/README.md). `scripts/dima-update` is the human operator's tool; agents must not invoke or modify it.
- Preview with `scripts/saas-ops preview docs --port 4322` from the repository root. Check changed pages, links, affected languages, and mobile/desktop layouts; Ctrl-C stops and removes the isolated preview.
- Run `scripts/saas-ops build docs`, then use the exact generated run ID with `verify docs-<run-id> --check <behavior-script>`, `deploy docs-<run-id>`, and `cleanup docs-<run-id>` through the same helper. Build output stays outside the live mount until verified publication to `dimadocs/dist/`.
- The helper preserves a rollback bundle and verifies served entrypoints. Check changed live pages/links too; use `rollback docs-<run-id>` for a regression. No nginx restart is needed for content changes.
- `dimadocs/docker-compose.yml` owns the service. Validate nginx config changes in isolation before applying, then run `nginx -t` and reload only the affected production nginx process.

---

**This file is intentionally lightweight.** Add MDX authoring guidelines or content-structure notes here as the documentation grows. Root rules always take precedence.
