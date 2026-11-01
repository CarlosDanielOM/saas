# dimadb

Internal database console with an Angular single-page UI and a same-origin Node API in one container. It supports Redis/Dragonfly and MongoDB connections. The API and static UI share the same origin; the container listens on port 80 inside Docker networks and publishes no host port.

## Routes and setup

- `/setup` is shown when no user account has been created.
- `/browse`, `/console`, `/connections`, and `/account` are application routes.
- `GET /api/health` is the API health endpoint. Other `/api` requests require the `X-Dimadb: 1` header; protected operations also enforce the session or setup/login rules for that endpoint.

The Compose service can seed optional connections from `DIMADB_REDIS_DRAGONFLY` and `DIMADB_MONGO_DIMABOT`; users can also add connection URLs in the UI. See [`AGENTS.md`](AGENTS.md) for storage, access-control, and delivery details.

## Development and releases

The Compose file joins external `web-proxy` and `databases` networks and persists account and connection data in `./data`. This is an internal production service, so do not start its Compose configuration against production resources for local development. Use a disposable configuration and data directory for isolated work. Supported releases use `scripts/saas-ops` target `dimadb`, including an isolated candidate build and behavior verification; see [`../ops/README.md`](../ops/README.md).
