# Dima Analytics

`dima-analytics` is the private service that stores and serves application observability and infrastructure resource data. The API server forwards the analytics UI's requests to it on the internal `databases` network. The service authenticates Twitch sessions against the shared Dragonfly session cache (and Twitch validation when needed), applies channel/service grants, and stores data in its dedicated PostgreSQL database.

For streamer-facing analytics coverage and planned work, see the [tracking checklist](TRACKING_CHECKLIST.md). This service's metrics describe application and infrastructure health; they are separate from per-channel stream analytics.

The runtime is `node src/index.mjs` on port `3210`. `/health` checks PostgreSQL and reports whether the Redis buffer is ready and when the last batch was ingested. The Compose service has no published host port; its database/network access comes from the external `databases` network.

## Configuration

The first-install script writes `dima-analytics/.env` with mode `0600`. It generates the PostgreSQL application password and the MongoDB metrics-monitor password, then writes the service connection settings. Do not commit or copy this file into tickets or logs.

| Variable | Purpose |
| --- | --- |
| `DATABASE_URL` | Required PostgreSQL URL for the dedicated `observability` database. |
| `OWNER_TWITCH_ID` | Required Twitch user ID with implicit owner access. |
| `REDIS_URL` | Dragonfly URL used for sessions, identity cache, and telemetry buffer. Defaults to `redis://dragonfly:6379`. |
| `MONGO_METRICS_URI` | Optional read-only MongoDB monitoring connection used by the resource collector. |
| `QDRANT_URL` | Optional Qdrant metrics endpoint. |
| `QDRANT_API_KEY` | Optional key for the Qdrant metrics endpoint. |
| `COLLECTORS_DISABLED` | Set to `true` to disable periodic infrastructure collectors. |
| `PORT` | HTTP port; defaults to `3210`. |

## Data flow and collection

The API, bot, and cron processes aggregate bounded metric labels in memory and flush every 10 seconds into the Redis list `observability:v1:inbox`. Metrics are bucketed into 10-second, 60-second, and one-hour aggregates in PostgreSQL. Each process limits pending metric series, spans, logs, batch sizes, and the Redis inbox; when a buffer is full or Redis is unavailable, telemetry is dropped rather than blocking application requests. The Redis inbox expires after one hour, and the analytics consumer keeps an in-progress batch so it can resume after a restart.

Metrics are aggregated without sampling. Traces are sampled at 1%; spans lasting at least one second and error spans are also retained when not sampled and marked partial. Only warning, error, and fatal log records are sent, and their fields come from a fixed metadata allowlist. Telemetry excludes chat text, command arguments, HTTP bodies and query strings, database statements, headers, and credentials.

The resource collector runs every 30 seconds. It records selected PostgreSQL, Dragonfly, Qdrant, and MongoDB resource statistics when configured, plus analytics process memory and bounded queue depth/age observations. Queue discovery uses incremental, limited Redis scans rather than `KEYS` or an unbounded scan. Collector failures are reported as `collector_up=0` for the affected dependency and through `collectorError` in resource responses; they do not stop the API. `/health` reports PostgreSQL readiness, Redis buffer readiness, and the last ingestion time.

## Access and query limits

The service accepts analytics requests only after resolving the bearer token to a Twitch identity. Browser-supplied user IDs are not trusted. The configured owner receives system-wide access. The owner can grant other users `viewer` or `investigator` access, optionally restricted to channel IDs, service names, and an expiry. Grant changes are recorded in the audit table.

Viewers can query metric overviews and resources when their grant has no channel restrictions; channel-scoped grants are denied access to resources. Investigators can also query traces and logs. Channel and service grant filters are always applied in addition to query filters. Overview ranges are limited to supported presets from 15 minutes through 365 days. Overviews are aggregated in PostgreSQL, so their totals are complete for every range: 15-minute and 1-hour ranges read 10-second buckets, 6- and 24-hour ranges read 60-second buckets, and longer ranges read one-hour buckets, while the latest value per series comes from recent finer buckets. Resource responses keep the newest sample per series in about 360 time slots per range. Trace lists, trace detail, and log lists are capped, so those responses may be partial.

The API reports latency percentiles as histogram upper bounds. Missing buckets mean no data was observed, not zero activity. Unsampled long/error traces are partial, and no trace view guarantees a complete request path. Data is aggregated and bounded; this service is not a raw request archive.

## Retention

The hourly retention task keeps metric aggregates at 10-second resolution for 2 days, 60-second resolution for 30 days, and one-hour resolution for 365 days. Trace spans are retained for 3 days, logs for 7 days, and resource samples for 30 days. Ingestion batch receipts expire after 2 days, and grant audit records after 365 days. Retention is enforced by dropping expired daily partitions and deleting expired aggregate rows.

## First install and later releases

The bootstrap is a first-install workflow because the service needs its own PostgreSQL role/database and a read-only MongoDB monitoring account. Run it from the production checkout after reviewing its scope:

```bash
python3 ops/bootstrap_analytics.py verify /root/saas/dima-analytics /path/to/analytics-receipt.json
python3 ops/bootstrap_analytics.py install /path/to/analytics-receipt.json
```

`verify` builds and exercises the candidate with disposable PostgreSQL and Dragonfly dependencies, then removes its containers and network. `install` accepts only that verified image and starts only the analytics service. It refuses a pre-existing analytics container or pre-existing analytics role/database on initial provisioning, saves credentials in `.env`, and verifies that `/root/databases/docker-compose.yaml` is unchanged. Inspect any interrupted provisioning before retrying; credentials and partially created accounts are not rotated automatically.

After the first install, use `scripts/saas-ops` target `analytics` for code releases. See [`../ops/README.md`](../ops/README.md) for the full delivery and verification sequence. Database/schema or Compose changes require their separately reviewed workflow.
