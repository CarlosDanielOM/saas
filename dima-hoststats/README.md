# Dima Host Stats

Read-only sidecar that samples the host and the SaaS containers every 15 seconds and serves the latest snapshot on the internal `databases` network (`http://dima-hoststats:3211`). It has no published port and no dependencies beyond Node.

## What it reports

- **Host** (from the host-wide `/proc` files visible in the container): CPU % (whole machine), iowait/steal, load averages, processes, memory used/available/cache/shared, swap, disk size/used/free and inodes for the Docker disk (`statfs('/')`), disk read/write rates (`/proc/diskstats`), physical NIC traffic (host `/proc/1/net/dev`, bind-mounted read-only), and pressure stall averages.
- **Containers** in allowlisted Compose projects: state, health and failing streak, start/finish time, exit code, OOM kill, restart count and policy, CPU % of one core, memory (excluding reclaimable file cache, like `docker stats`) and limit, CPU and PID limits, network and block I/O totals and rates, image size, writable-layer size and volume size.
- **Docker disk use** (`/system/df`, every 10 minutes because it is slow): images (shared layers counted once) and unused images, build cache and its reclaimable part, volumes, container layers.

Bind-mounted data directories (e.g. `/root/databases/*`) are not measured; database sizes come from the databases themselves through `dima-analytics`.

## Routes

- `GET /health`: 200 while the sampler is running (Docker reachability is reported, not required).
- `GET /v1/snapshot`: the latest snapshot JSON. Any other method returns 405.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `HOSTSTATS_PROJECTS` | SaaS projects | Comma-separated Compose projects to report. |
| `HOSTSTATS_SAMPLE_MS` | `15000` | Sample interval (min 5 s). |
| `HOSTSTATS_DF_MS` | `600000` | Docker disk-usage interval (min 60 s). |
| `PORT` | `3211` | HTTP port. |

## Security

The container runs as `node` with the Docker socket's group (`group_add`), a read-only root filesystem, all capabilities dropped, `no-new-privileges`, 128 MB / 0.25 CPU / 32 PIDs, and the socket mounted read-only. A read-only socket mount does not limit the Docker API, so the code enforces the boundary: only `GET` on `/version`, `/system/df`, `/containers/json?all=1`, `/containers/<id>/json` and one-shot `/containers/<id>/stats` is possible, and only selected numeric/state fields leave the process.

## Tests and releases

`npm test` runs the parser, allowlist and fake-Docker end-to-end tests. Releases use `scripts/saas-ops` target `hoststats`; the candidate runs without the socket during verification, so verify with a check that runs `npm test` and reads `/v1/snapshot` host fields.
