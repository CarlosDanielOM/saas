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

## Production Verification & Deployment

- This checkout is on production. Follow the root workflow; successful isolated verification is followed by deployment as part of the requested implementation unless the user limits scope.
- **Client edits are immediately live:** `dimafx/docker-compose.yml` mounts the entire `dimafx/` directory into nginx. Prepare HTML/JS/CSS/assets changes in an isolated worktree/copy outside this directory. Serve that copy on an unused loopback port and check the affected panel/config/mobile flows with a mocked or controlled test extension context. Keep test fixtures and secrets outside the served directory.
- Preserve the previous client files, then apply only the validated changes to the production checkout. Verify the served result and restore those files if it fails. No client build or nginx restart is required. Stop/remove the preview resources.
- For server changes, build `dimafx/server/Dockerfile` with a unique test tag and run a disposable container with test JWT/service configuration and a mocked/test backend. Check startup and changed requests; do not point test traffic at the production backend or weaken production JWT verification.
- Remove test resources, retain the previous production image for rollback, then run `docker compose up -d --build --no-deps dimafx-server` from `dimafx/`. Check readiness/logs and a scoped smoke test, restoring the previous image if the release fails.
- For nginx config changes, validate in an isolated container before applying; check with `nginx -t` and reload the affected production nginx process.

## Styling

- Component/page styles live alongside their HTML/JS files (e.g., `panel.css`, `mobile.css`).
- Follow the hybrid styling policy from root `AGENTS.md` when adding new CSS.

---

**This file is intentionally lightweight.** Add extension-specific patterns, JWT handling notes, or asset guidelines here as the extension evolves. Root rules always take precedence.
