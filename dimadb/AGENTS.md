# dimadb Agent Guide

**This document supplements the root `saas/AGENTS.md`.** Read the root file first.

## Project Purpose

`dimadb/` is an internal database console. Angular CSR UI + Node API live in **one container**. NPM should proxy to `dimadb:80` on `web-proxy`. Do not publish host ports.

## Key Entry Points

- `src/app/app.routes.ts` – Angular routes
- `server/index.mjs` – HTTP server (`/` static SPA, `/api` backend)
- `docker-compose.yaml` – single service `dimadb`

## Runtime

- Container listens on port 80 inside Docker networks only.
- Persist users/connections on `./data` (`DATA_DIR=/data`).
- API is same-origin. Mutating/authenticated routes require `X-Dimadb: 1`.
- Frontend rebuild inside the image: `docker compose up -d --build`.

## Angular

- v22, zoneless, standalone, signals, OnPush, Tailwind v4.
- Mobile-first dark UI. Component-scoped CSS for pages.

## Current Status

Auth, `/data` persistence, connections, Redis browse/console/edit, and MongoDB connections/browse are wired.

- First visit with no users → `/setup`
- Session cookie + `X-Dimadb: 1`
- Seed Redis with `DIMADB_REDIS_*` and Mongo with `DIMADB_MONGO_*`, or add URLs in the UI
