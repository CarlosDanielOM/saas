# admin Agent Guide

**This document supplements the root `saas/AGENTS.md`.** Read the root file first for monorepo rules.

## Project Purpose

`admin/` is the **internal-only** administrative panel for moderation, support, and operations tooling. It is not exposed to end users.

## Key Entry Points

- `src/app/app.routes.ts` – Route definitions
- `src/app/app.config.ts` – Angular bootstrap configuration
- `src/app/guards/admin-auth.guard.ts` – Authentication guard

## Architecture Notes

- Angular v21 standalone components + signals.
- Uses the same `plan_tier` and authentication patterns as `dimasite/`.
- All API calls go through the shared backend (`dimabot`).
- Keep sensitive operations behind proper admin role checks.

## Styling

Follow the hybrid styling policy defined in root `AGENTS.md`. Component-scoped `.css` files are encouraged for page-level layouts.

## Responsive Design Priority

- **Mobile-first approach**: Design and implement for the smallest viewport first (320px–480px base).
- Progressively enhance for tablet (768px+) and desktop (1024px+) breakpoints.
- Prefer `min-width` media queries over `max-width` (mobile-first).
- Always test layouts on real mobile devices or mobile emulation before considering desktop complete.

## Access Control

- Only users on the admin whitelist (`src/app/config/admin-whitelist.ts`) may access.
- All routes under the admin area should be protected by `admin-auth.guard`.

## Production Verification & Deployment

- Use `scripts/saas-ops` target `admin` and [`../ops/README.md`](../ops/README.md). `scripts/dima-update` is the human operator's tool; agents must not invoke or modify it.
- Preview with `scripts/saas-ops preview admin --port 4202` from the repository root. Inspect API/environment targets before interacting; test moderation and other mutations with mocks or designated test data. Check mobile/desktop layouts and changed flows, then Ctrl-C to stop the isolated preview.
- Run `scripts/saas-ops build admin`, then `verify admin-<run-id> --check <behavior-script>`, `deploy admin-<run-id>`, and `cleanup admin-<run-id>` through the same helper. Use the exact generated run ID. Builds occur outside the live directory; publication backs up and updates `admin/dist/admin/browser/` without restarting nginx.
- The helper verifies served entrypoints and restores the prior bundle on failure. Add relevant production smoke checks; use `rollback admin-<run-id>` for a regression discovered afterward.
- `admin/docker-compose.yaml` owns `dima-admin`. Nginx config changes require isolated validation, then a production `nginx -t` and targeted reload.

---

**This file is intentionally lightweight.** Add internal tooling patterns or moderation workflow notes here as needed. Root rules always take precedence.
