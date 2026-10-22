# Dima Host Stats Agent Guide

`dima-hoststats` is a tiny read-only sidecar that reports host CPU, memory, disk, network and per-container Docker stats for the SaaS. `dima-analytics` polls it every 30 seconds, stores trends, and the admin **System analytics → Servers** tab shows them. Read [`README.md`](README.md) for the data it exposes and its security boundaries.

## Source of truth

- `src/parse.mjs`: pure parsers for `/proc` files and Docker API payloads (unit-tested with fixtures).
- `src/index.mjs`: the Docker read allowlist, sampler and the two HTTP routes (`/health`, `/v1/snapshot`).
- `docker-compose.yaml`: socket/proc mounts, `group_add` for the socket's group, limits and the Compose-project allowlist (`HOSTSTATS_PROJECTS`).
- Consumer: `dima-analytics/src/infrastructure.mjs` validates every field it accepts. Add a field in both places or it is dropped.

## Rules

- The Docker socket is root-equivalent. Keep every Docker call a `GET` on the fixed allowlist in `src/index.mjs`. Never add exec, logs, inspect output passthrough, environment variables, or any write endpoint. Never publish a host port.
- Report only containers whose Compose project is in `HOSTSTATS_PROJECTS` (SaaS projects). Test candidates and one-off containers have no Compose label and are skipped.
- Releases use `scripts/saas-ops` target `hoststats` (see `../ops/README.md`). Compose/mount/group changes are configuration changes and need their own reviewed procedure.
