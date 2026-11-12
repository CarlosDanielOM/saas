# Production baseline before the migration

Read by the owner from the admin site's Servers page on 2026-11-11 at 17:26 (MST) and recorded here
as the "before" for the resource report at the end of the migration. Container memory is as
`docker stats` reports it (file cache the container can give back is left out); CPU is the share of
one core. These are single readings, not averages.

## What the migration replaces

| Container | What runs in it today | Memory | CPU |
|---|---|---|---|
| `dima-cron` | Node supervisor, 18 TypeScript workers as separate Node processes, the Rust index and 7 Rust workers | 3.10 GiB | 22% |
| `dima-server` | API server (Node) | 268 MiB | 4.6% |
| `dima-bot` | Chat bot (Node) | 162 MiB | 1.4% |
| `dimafx-server` | Extension server (Node) | 29.3 MiB | <0.1% |
| `dima-analytics` | Analytics (Node), limit 512 MiB | 71.5 MiB | 2.0% |
| `dima-hoststats` | Host stats (Node), limit 128 MiB | 34.6 MiB | 1.6% |
| `dimadb` | DB console (Node) | 34.4 MiB | 0% |
| **Total** | | **about 3.70 GiB** | |

The three `dimabot` containers together are 3.52 GiB, 12% of the server's memory.

## Per process inside those containers

Resident memory, heap, CPU and the 99th-percentile event-loop delay ("stalls") as each process
reports them.

| Process | Runtime | Memory | Heap | CPU | Stalls |
|---|---|---|---|---|---|
| Semantic moderation worker | Node | 262 MiB | 121 MiB | 1.2% | 21 ms |
| API server | Node | 258 MiB | 149 MiB | 1.3% | 21 ms |
| Chat bot | Node | 181 MiB | 116 MiB | 1.2% | 21 ms |
| Stream memory worker | Node | 169 MiB | 111 MiB | 0.3% | 21 ms |
| Follow defense actions worker | Node | 166 MiB | 65.5 MiB | 1.6% | 21 ms |
| AI usage backfill worker | Node | 148 MiB | 87.0 MiB | 0.4% | 21 ms |
| VOD clip recommender worker | Node | 143 MiB | 99.2 MiB | 0.3% | 21 ms |
| Timer worker | Node | 143 MiB | 95.5 MiB | 0.4% | 21 ms |
| Roulette actions worker | Node | 141 MiB | 97.9 MiB | 0.5% | 21 ms |
| Credit gifts worker | Node | 140 MiB | 93.1 MiB | 0.5% | 21 ms |
| Duel worker | Node | 136 MiB | 93.9 MiB | 0.6% | 21 ms |
| Free credit reset worker | Node | 134 MiB | 85.6 MiB | 0.3% | 21 ms |
| Temporary roles worker | Node | 133 MiB | 93.3 MiB | 0.3% | 21 ms |
| Domain events worker | Node | 92.4 MiB | 48.9 MiB | 0.8% | 21 ms |
| Follow ledger worker | Node | 80.8 MiB | 36.4 MiB | 0.4% | 21 ms |
| Stream analytics worker | Node | 80.4 MiB | 37.2 MiB | 0.4% | 20 ms |
| Activation reminder worker | Node | 78.9 MiB | 42.6 MiB | 0.3% | 20 ms |
| Goals worker | Node | 62.0 MiB | 28.0 MiB | 0.4% | 20 ms |
| Widgets worker | Node | 59.7 MiB | 27.4 MiB | 0.4% | 20 ms |
| Follow defense worker | Node | 58.8 MiB | 24.8 MiB | 0.5% | 21 ms |
| Cron index (supervisor) | Node | 44.9 MiB | 12.2 MiB | 0.3% | 21 ms |
| Dashboard activity worker | Rust | 6.7 MiB | | 1.5% | |
| AI usage receipts worker | Rust | 4.5 MiB | | 0.2% | |
| Raid analytics worker | Rust | 4.1 MiB | | 0% | |
| Raid sessions worker | Rust | 3.4 MiB | | 0.4% | |
| Stream activity worker | Rust | 3.3 MiB | | 0.3% | |
| Follow defense baseline worker | Rust | 3.0 MiB | | 0% | |
| Roulette completion worker | Rust | 2.3 MiB | | 0.2% | |
| Cron index (Rust supervisor) | Rust | 1.7 MiB | | 0.2% | |

The 19 Node processes of the cron container add up to about 2.27 GiB of resident memory; the 8 Rust
processes in the same container add up to about 29 MiB.

## What stays (context for the totals)

| Group | Containers | Memory |
|---|---|---|
| Databases | MongoDB 1.87 GiB (limit 5), Qdrant 1.61 GiB (limit 6), PostgreSQL 251 MiB (limit 4), Dragonfly 104 MiB (limit 4) | 3.83 GiB |
| AI helpers | Embeddings 2.83 GiB (limit 4), Piper voices 694 MiB | 3.51 GiB |
| Websites | HTTPS proxy 291 MiB, docs site 15.4 MiB, website 15.3 MiB, admin site 14.3 MiB, extension files 13.5 MiB | about 350 MiB |
| System and other | Kernel, Docker, programs outside containers | 8.62 GiB |
| Available | | 10.6 GiB (35%) |

## How the "after" will be measured

The same page, the same way, after the cutover has run for at least a day: the three Rust `dimabot`
containers and the four small services, per-container memory and CPU, next to this table. The pilot's
laboratory numbers (the DB console: 7.5 MB against 102 MB after start) are not a production
measurement and are not to be quoted as one.
