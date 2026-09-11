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

- This checkout is on production. Follow the root workflow: preview, validate, then deploy the requested change without an additional approval unless the user limits scope.
- Preview with `npm run start --prefix admin -- --host 127.0.0.1 --port 4202 --configuration development` from the repository root, choosing an unused port. Inspect API/environment targets before interacting; test moderation and other mutations with mocks or designated test data. Check mobile/desktop layouts and the changed flows.
- Preserve the previous bundle, then run `npm run build --prefix admin`. This writes directly to `admin/dist/admin/browser/`, mounted into `dima-admin`; build output changes are immediately visible to production. For preliminary production-build validation, use a separate checkout/output outside that mount.
- Verify the served page/assets and restore the previous complete bundle if the build or live verification fails. Stop the preview process. Bundle updates require no nginx restart.
- `admin/docker-compose.yaml` owns `dima-admin`. Nginx config changes require isolated validation, then a production `nginx -t` and targeted reload.

---

**This file is intentionally lightweight.** Add internal tooling patterns or moderation workflow notes here as needed. Root rules always take precedence.
