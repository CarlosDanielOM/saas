# Dima Analytics Agent Guide

`dima-analytics` owns the private observability HTTP API, telemetry ingestion, PostgreSQL schema/retention, and periodic infrastructure collectors. Read [`README.md`](README.md) for runtime configuration, access scopes, collection limits, retention, and first-install/release workflows.

## Source of truth

- `src/index.mjs` defines authentication, authorization, HTTP routes, batch consumption, and lifecycle timers.
- `src/store.mjs` defines validation, schema, aggregation, query scopes, and retention.
- `src/collectors.mjs` defines resource metrics and bounded queue discovery.
- `src/infrastructure.mjs` validates the `dima-hoststats` snapshot, stores host/container trends and hourly rollups, and serves them through `/api/resources?include=`.
- `docker-compose.yaml` and `dockerfile` define the runtime container and external network attachment.
- `ops/bootstrap_analytics.py` owns first-install verification and provisioning. Existing service releases use `scripts/saas-ops` target `analytics`; see [`../ops/README.md`](../ops/README.md).

Read these files before changing related behavior; this guide and README summarize, but do not replace, implementation contracts.

## Operational boundaries

- The analytics database is a dedicated database on the existing PostgreSQL service. Do not edit or redeploy `/root/databases/docker-compose.yaml` as part of analytics work.
- The service shares the external `databases` network. Its Compose service does not publish a host port.
- Treat analytics grants and their channel/service filters as security boundaries. Resolve identities from the bearer session; never trust a browser-supplied Twitch ID.
- Keep telemetry bounded and metadata-only. Do not export message text, command arguments, request bodies, query strings, database statements, headers, or credentials.
- Preserve bounded Redis scans, batch limits, partial-trace semantics, and explicit retention windows unless the task specifically changes them.
- Do not claim missing metric buckets are zero or trace data is complete. See the query and retention limits in the README and their implementation in `src/store.mjs`.
- Do not manually modify generated `.env` credentials or repeat first-install provisioning on an existing installation. Use the bootstrap for an authorized first install and the helper target for later code releases.
