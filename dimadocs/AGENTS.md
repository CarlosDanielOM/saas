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

## Styling

- Global styles live in `src/styles/custom.css`.
- Follow the design tokens and plan-tier conventions from the root design system when applicable.

---

**This file is intentionally lightweight.** Add MDX authoring guidelines or content-structure notes here as the documentation grows. Root rules always take precedence.