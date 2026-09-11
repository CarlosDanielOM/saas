# dimadb Agent Guide

**This document supplements the root `saas/AGENTS.md`.** Read the root file first.

## Project Purpose

`dimadb/` is an internal database console. Angular CSR UI + Node API live in **one container**. NPM should proxy to `dimadb:80` on `web-proxy`. Do not publish production host ports; isolated temporary previews may use loopback as described below.

## Key Entry Points

- `src/app/app.routes.ts` – Angular routes
- `server/index.mjs` – HTTP server (`/` static SPA, `/api` backend)
- `docker-compose.yaml` – single service `dimadb`

## Runtime

- Container listens on port 80 inside Docker networks only.
- Persist users/connections on `./data` (`DATA_DIR=/data`).
- API is same-origin. Mutating/authenticated routes require `X-Dimadb: 1`.
- Frontend is built inside the image; deploy only after the isolated verification below.

## Production Verification & Deployment

- This checkout is on production. A requested implementation includes isolated validation, cleanup, and targeted deployment unless the user limits scope.
- For UI changes, preview Angular on an unused loopback port using the development configuration. Exercise UI flows against a disposable API and test data, not production database connections.
- Use `scripts/saas-ops` target `dimadb` and [`../ops/README.md`](../ops/README.md): plan, build, verify the generated run with a behavior check, deploy, then cleanup. Test storage is disposable; never mount `dimadb/data/` or inherit production connection URLs. The baseline check is `ops/checks/dimadb.mjs`; add cases for the changed feature.
- Verify startup, the changed UI/API flows, and relevant authentication checks. Remove only task-owned test containers/networks/volumes after testing; retain production data untouched.
- The helper preserves rollback and promotes the exact tested image. Check readiness, logs, and the served app; use `scripts/saas-ops rollback <run-id>` for a regression. The UI deploys with the container, not with a host Angular build. `scripts/dima-update` belongs to the human operator; agents must not invoke or modify it.
- Production listens only on Docker networks. Temporary previews may bind an unused `127.0.0.1` port; remove them after verification. Never use `down -v` or broad prune commands to clean up this service.

## Angular

- v22, zoneless, standalone, signals, OnPush, Tailwind v4.
- Mobile-first dark UI. Component-scoped CSS for pages.

## Current Status

Auth, `/data` persistence, connections, Redis browse/console/edit, and MongoDB connections/browse are wired.

- First visit with no users → `/setup`
- Session cookie + `X-Dimadb: 1`
- Seed Redis with `DIMADB_REDIS_*` and Mongo with `DIMADB_MONGO_*`, or add URLs in the UI
