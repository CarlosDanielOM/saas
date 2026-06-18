# dimafx Agent Guide

**This document supplements the root `saas/AGENTS.md`.** Read the root file first for monorepo rules.

## Project Purpose

`dimafx/` is the Twitch Extension (client + server) that provides on-stream overlays, alerts, sound effects, and configuration UI for broadcasters.

## Key Entry Points

- `panel.html`, `config.html`, `mobile.html` – Extension UI entry points
- `panel.js`, `config.js`, `mobile.js` – Client-side logic
- `server/src/server.ts` – Extension backend (authentication, API proxy)
- `server/src/routes/extension.routes.ts` – Extension-specific endpoints

## Architecture Notes

- Client is lightweight HTML/JS (no heavy framework) for fast loading inside Twitch.
- Server is a small Node.js/Express app that handles Twitch Extension JWT validation and proxies requests to the main `dimabot` API.
- Uses `dimafx/server/src/middleware/twitch-extension-auth.ts` for JWT verification.
- Assets (images, sounds) live in `assets/`.

## Development

- Client files are served statically.
- Server runs via Docker (`docker-compose.yml`).
- Configuration and panel UIs must respect Twitch Extension UX guidelines (small footprint, fast load).

## Styling

- Component/page styles live alongside their HTML/JS files (e.g., `panel.css`, `mobile.css`).
- Follow the hybrid styling policy from root `AGENTS.md` when adding new CSS.

---

**This file is intentionally lightweight.** Add extension-specific patterns, JWT handling notes, or asset guidelines here as the extension evolves. Root rules always take precedence.