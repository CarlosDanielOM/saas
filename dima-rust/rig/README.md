# dima-rig: the side-by-side rig

`dima-rig` runs the **reference** (the frozen TypeScript) and the **candidate** (the Rust port)
on the same scenario from the same initial state and compares what each one did: every HTTP
response, then the final MongoDB state (typed documents and indexes), then the final Dragonfly
state (keys, types, values, TTLs). Run-time values (generated ids, times, ports) are normalised;
nothing else is forgiven unless a scenario allows it with a reason.

Sides never run at the same time. Each side gets its own loopback ports, a fresh MongoDB
database (`rig_<pid>_<n>_<side>`, dropped afterwards) and its own Dragonfly logical database
(1 to 9, claimed with a file lock, flushed with `FLUSHDB`), seeded identically.

```
rig/
  targets/<target>.json                    how to launch each side
  scenarios/<target>/<area>/<name>.json    what to do (one scenario per file)
  scenarios/<target>/_seeds/*.json         reusable seed files (names starting with _ are not scenarios)
  captures/<target>/<area>/<name>.json     recorded reference captures (committed)
  out/                                     logs and reports (git-ignored)
  tests/selftest-rig/                      the self-test target, a complete small example
```

## Commands

```sh
eval "$(dima-rust/tools/test-env)"       # DIMA_TEST_MONGO_URI, DIMA_TEST_DRAGONFLY
R=dima-rust/tools/cargo; $R build -p dima-rig
RIG=${CARGO_TARGET_DIR:-$HOME/.cache/dima-rust/target}/debug/dima-rig

$RIG record  <target> [scenario...]      # run the reference twice, check it is stable, write captures
$RIG verify  <target> [scenario...]      # run the candidate, compare with the captures
$RIG compare <target> [scenario...]      # run both live and compare (no captures involved)
$RIG diff-get <target> --db <name> --paths <list.json>   # GET requests over an existing database
$RIG check   <target> [scenario...]      # parse target and scenarios, report stale or missing captures
$RIG gc                                  # drop rig_ databases left by rig processes that are gone
```

A scenario argument is a name (`items/create`), a directory (`items`) or a glob (`*/create`).
Options (before or after the command): `--set name=value` fills `{var.name}` in targets;
`--rig-dir`, `--captures-dir`, `--out-dir`; `--mongo-uri`, `--dragonfly host:port`,
`--dragonfly-dbs 1-9`; `--report <file>`; `--keep` keeps the side databases for inspection;
`record --once` skips the stability run.

Exit code: **0** only when every scenario matched (or was recorded) and no side failed;
**1** differences or a side failure; **2** the rig itself could not run (bad file, store down);
**130** interrupted (side processes are killed and the rig's databases dropped).

`record` writes a capture only when it changed beyond the tolerances (otherwise `UNCHANGED`), so
re-recording does not churn the files. If the two reference runs disagree the scenario is
`UNSTABLE` and nothing is written: fix the scenario or add an allowance.
A capture stores the hash of its scenario and of every seed it includes; `verify` refuses a stale
capture (`capture is stale ... run dima-rig record`).

## Target file

`targets/<target>.json`. Every key below is checked; unknown keys are errors.

```json
{
  "rig_target": 1,
  "description": "dimafx-server: TypeScript reference against the Rust binary.",
  "ports": ["http"],
  "reference": {
    "command": ["node", "dist/server.js"],
    "cwd": "dimafx/server",
    "env": { "PORT": "{port}", "MONGO_URI": "{mongo_uri}", "REDIS_URL": "{dragonfly_url}", "NODE_ENV": "test" },
    "pass_env": ["PATH", "HOME"],
    "ready": { "http": "/health", "timeout_ms": 20000 },
    "stop": { "signal": "SIGTERM", "grace_ms": 5000 }
  },
  "candidate": {
    "command": ["{cargo_target_dir}/debug/dimafx-server"],
    "env": { "PORT": "{port}", "MONGO_URI": "{mongo_uri}", "REDIS_URL": "{dragonfly_url}" },
    "ready": { "tcp": true, "timeout_ms": 10000 }
  }
}
```

- `ports`: names of the loopback ports each side gets (default `["http"]`). A free port is
  chosen per launch.
- `command` (program then arguments), `cwd` (relative to the repository root; default the root)
  and every `env` value are templates. Placeholders: `{port}` (the first port), `{port.<name>}`,
  `{mongo_uri}` (root URI with the side's database as its path), `{mongo_root_uri}`,
  `{mongo_db}`, `{dragonfly_host}`, `{dragonfly_port}`, `{dragonfly_db}`, `{dragonfly_url}`
  (`redis://host:port/<db>`), `{side}` (`reference` or `candidate`), `{repo}`, `{rig_dir}`,
  `{cargo_target_dir}`, `{var.<name>}` (from `--set`). `{{` and `}}` are literal braces.
- **The environment is built from `env` only.** Nothing of the rig's own environment leaks in,
  except the names listed in `pass_env`. A bare program name is looked up on the side's `PATH`,
  or the rig's when the side has none.
- `ready`: exactly one of `"http": "/path"` (GET until 2xx, or `"status": <code>`) or
  `"tcp": true`; `port` picks a named port (default the first); `timeout_ms` is required.
- `stop`: signal to the whole process group (`SIGTERM` default, `SIGINT`, `SIGQUIT`, `SIGHUP`),
  then `SIGKILL` of the group after `grace_ms` (default 5000).

Each launch logs its output to `out/logs/<target>/<run>-<side>-<n>.log`. When a side fails to
start, dies, or a step fails, the report shows the log's last 30 lines. A side that exits on its
own is always a failure, and the next scenario gets a fresh process.

## Scenario file

`scenarios/<target>/<area>/<name>.json`. Strict: an unknown key is an error that lists the
expected keys.

```json
{
  "rig_scenario": 1,
  "description": "Create an item, read it back, and see the cache entry with its TTL.",
  "seed": {
    "include": ["../_seeds/users.json"],
    "mongo": {
      "items": [
        { "_id": { "$oid": "650000000000000000000010" }, "qty": { "$numberInt": "7" },
          "leaseUntil": { "$rigNow": "+60s", "as": "double" } }
      ]
    },
    "dragonfly": [["SET", "config:greeting", "héllo 👋"], ["EXPIRE", "config:greeting", "600"]]
  },
  "steps": [
    { "name": "create", "http": { "method": "POST", "path": "/items",
        "json": { "name": "🍕 pizza", "qty": 3 },
        "expect": { "status": 201 }, "save": { "item": "body.id" } } },
    { "http": { "method": "GET", "path": "/items/${item}", "headers": { "authorization": "Bearer t" } } },
    { "wait_for": { "mongo": { "collection": "jobs", "filter": { "item": { "$oid": "${item}" } } }, "timeout_ms": 5000 } },
    { "wait_quiet": { "quiet_ms": 300, "timeout_ms": 5000, "ignore_keys": ["metrics:*"] } },
    { "dragonfly": ["TTL", "item:${item}"] }
  ],
  "compare": { "mongo": { "exclude": ["logs*"] }, "headers": { "add": ["etag"] } },
  "allow": [
    { "path": "steps[1].body.tags", "kind": "set", "reason": "Tags come from a Set; the reference does not order them." }
  ]
}
```

Top level: `rig_scenario` (1), `description` (required), `seed`, `steps` (required), `compare`,
`allow`, `restart` (default `false`), `tolerance_ms` (default 2000).

**Seed.** `mongo` maps collection to documents in **canonical Extended JSON**: every number names
its BSON type (`$numberInt`, `$numberLong`, `$numberDouble`, `$numberDecimal`; a bare number is an
error), dates are `{"$date": "..."}`, ids `{"$oid": "..."}`, and every document needs an explicit
`_id`. A missing field stays missing, `null` is stored as null. `{"$rigNow": "<offset>", "as": ...}`
is the scenario start plus an offset (`0`, `+60s`, `-5m`, `150ms`, `+2h`, `+2d`), stored as a date
(default), `long` or `double` (epoch ms), `s` (epoch seconds) or `iso` (string). `dragonfly` is a
list of commands. `include` reads seed files (`{"rig_seed": 1, "description", "include",
"mongo", "dragonfly"}`), paths relative to the including file. Includes run first.

**Steps** run in order; each has an optional `name` and exactly one kind:

| Kind | Fields |
|---|---|
| `http` | `method` (GET POST PUT PATCH DELETE HEAD OPTIONS), `path` (starts with `/`), `port` (a target port name), `headers`, at most one body: `json`, `form` (object or `[[name, value], ...]`, URL-encoded), `text`, `body_base64`; `timeout_ms` (30000); `expect: {"status": 201 \| [200, 204]}`; `save: {"name": "status" \| "headers.<name>" \| "body" \| "body.a[0].b"}` |
| `dragonfly` | `["CMD", "arg", ...]` on the side's logical database; the reply is captured and compared. Commands that leave the logical database or block (`SELECT`, `FLUSHALL`, `SUBSCRIBE`, `BLPOP`, `COPY ... DB`, ...) are refused |
| `pause_ms` | a number of milliseconds |
| `wait_for` | `{"mongo": {"collection", "filter", "count"}}` (at least `count`, default 1, documents match) or `{"key": "pattern"}` (a key exists; `*` and `?` allowed), plus `timeout_ms` |
| `wait_quiet` | `quiet_ms` without any MongoDB or Dragonfly change, bounded by `timeout_ms`; `ignore_keys`, `ignore_collections` (globs) |

Strings in paths, headers, bodies, commands and filters may use `${name}` (a value saved by an
earlier step), `${now_ms}`, `${now_s}`, `${now_iso}` with an optional offset (`${now_ms+60s}`);
`$${` is a literal `${`. JSON bodies and commands also take `$rigNow` (`as`: `ms` default, `s`,
`iso`). `expect` failing, a wait timing out, or a side dying fails the scenario (status `ERROR`),
on either side. Filters may use bare numbers (MongoDB compares numbers across types).

**restart: true** gives the scenario its own process, started after its seed (for start-up
behaviour). Otherwise the scenarios of a target share one process per side; between scenarios
the stores go back to the snapshot taken right after the process started, then the next seed is
written.

**compare** (default: everything): `mongo` and `dragonfly` take `{"only": [globs], "exclude":
[globs]}` over collection names and keys; `headers` is `{"only": [...]}` or `{"add": [...],
"remove": [...]}` over the default list `content-type, location, cache-control,
www-authenticate, retry-after, access-control-*, content-security-policy,
x-content-type-options` (lower case; the status is always compared; `etag` is off by default);
`as_text: [paths]` keeps Dragonfly strings at those paths as exact text instead of parsing
compact JSON. **Use `as_text` for values compared byte by byte** (queue items removed by value,
JSON compared in Lua, hashed payloads: MIGRATION.md section 7 rule 6), because parsed JSON
forgives key order.

**allow** is a list of `{"path", "kind", "reason"}`; the reason is mandatory. An allowance that
matched nothing is reported as a warning: remove stale ones.

| kind | effect |
|---|---|
| `ignore` | the value at the path is not compared, presence included |
| `set` | the array at the path is compared as a multiset |
| `tolerance` | with `"ms"`: times (and plain numbers) at the path compare within that margin |
| `generated` | the string at the path is a run-time token (numbered like an id, and followed into other strings and key names); with `"pattern": "<regex>"`, every match inside strings and key names at or below the path |

## Paths

Reports and allowances address values the same way: `steps[0].status`,
`steps[0].headers.content-type`, `steps[2].body.items[1].name`, `steps[3].reply`,
`mongo.items[0].qty` (documents in canonical order), `mongo.items.indexes.name_1.unique`,
`dragonfly["config:greeting"].ttl`, `dragonfly["item:<oid:1>"].value`, `mongo.c[0].ключ["🍕 pizza"]`.
Keys that are not letters, digits, `_` or `-` are quoted. In allowance paths `[*]` is any index,
a `*` segment is any one key or index, `**` is any depth, and `*` inside a key matches any run
(`created*`, `["item:*"]`).

## Normalisation

- **Generated ids.** An ObjectId whose timestamp falls in the side's lifetime, a v4 UUID (or a v7
  inside the lifetime), and values named by a `generated` allowance become numbered placeholders:
  `<oid:1>`, `<uuid:1>`, `<gen:1>`. One map per side across the whole capture (responses in step
  order, then MongoDB by collection, then Dragonfly), including inside strings and key names.
  Comparison binds reference `<oid:n>` to candidate `<oid:m>` on first meeting; any later
  disagreement is a `cross-reference differs` difference. Ids that appear in the scenario's inputs
  (seed, paths, bodies, commands) compare exactly.
- **Order.** Documents and keys are sorted by content with generated values masked (ids that look
  alike are told apart by where they are referenced), so runs that differ only in generated values
  give identical captures. Documents and keys are paired by content, identity, then similarity,
  so one extra document is one difference.
- **Times.** BSON dates, ISO strings (inside any string, format kept as a shape such as
  `dddd-dd-ddTdd:dd:dd.dddZ`), `YYYY-MM-DD` days, epoch-millisecond numbers (int64, double, JSON,
  13-digit runs in strings) and TTLs within 400 days of the run become `<t+153ms>` relative to the
  scenario start and compare within the tolerance; outside the run window the absolute time is
  kept too (`<t+60153ms@2026-...Z>`), so a fixed date near the run still matches days later.
  Times in the inputs, and times farther away, compare exactly. "No TTL" versus a TTL, a date
  versus an epoch number, and a different ISO format are differences.
- **Ports and the side's database name** become `<run:port.http>`, `<run:mongo_db>`.
- **JSON** (bodies, stored JSON): object key order is a note, not a failure; numbers compare by
  value (`5` = `5.0`, with a note inside stored JSON). **BSON** numbers compare by type and value.
  Arrays are ordered unless allowed as a `set`; Dragonfly sets and sorted sets are unordered.
- **Never forgiven:** missing versus null, empty string versus missing, string versus number, a
  different BSON type, an extra or missing document, field, key, index or collection, a different
  status, header, body, TTL class, or index key order.

## Captures

`captures/<target>/<scenario>.json`, versioned by `"rig_capture": 1` (bump it and re-record when
normalisation changes). Values are canonical Extended JSON (MongoDB) or plain JSON (responses)
with markers: `{"$oid": "<oid:1>"}`, `{"$date": "<t+153ms>"}`, `{"$numberLong": "<t+...>"}`,
`{"$rigNumber": "<t+...>"}` (a JSON epoch-ms number), `{"$rigText": "item:<oid:1>"}` (a string
with markers; `<<` is a literal `<`), keys `"$rigText:..."` and `"$rigLiteral:$set"`,
`{"$rigJson": ...}` (a Dragonfly string holding compact JSON), `{"$rigBytes": "<base64>"}`.
Response bodies are `{"json": ...}`, `{"text": ...}` or `{"base64": ...}`. Dragonfly entries
are `{"key", "type", "ttl" (null = no TTL), "value"}`: hashes as objects, lists as arrays, sets
sorted, sorted sets as `[{"member", "score"}]`, streams as `[{"id", "fields"}]`.

## Reports

Text on stdout, JSON in `out/report-<command>-<target>.json` (or `--report`):

```
DIFFER    items/create (1 difference, 2 notes)
  mongo.items[0].qty: type differs: reference int32, candidate int64
      in document _id {"$oid":"<oid:1>"}
      reference: {"$numberInt":"3"}
      candidate: {"$numberLong":"3"}
  note: steps[0].body: object key order differs
```

Statuses: `MATCH`, `DIFFER`, `ERROR` (a side failed or the scenario is invalid; the log tail
follows), `RECORDED`, `UNCHANGED`, `UNSTABLE`, `CHECKED`. JSON: `{"rig_report": 1, "command", "target",
"ok", "scenarios": [{"scenario", "status", "differences": [{"path", "what", "reference",
"candidate", "context"}], "notes", "warnings", "errors": [{"side", "step", "message", "log",
"log_tail"}]}]}`.

## diff-get (real data)

Both sides read an existing database (for example the local `domdimabot` copy) with their own
Dragonfly logical database; each request is one report entry. The rig compares the database's
`dbHash` and index lists before and after each side and fails a side that wrote
(`--no-write-check` skips this; the rig itself never writes there).

```json
{
  "rig_get_list": 1,
  "description": "Public read endpoints over the local production copy",
  "headers": { "accept": "application/json" },
  "requests": ["/api/health", { "path": "/api/streamers/foo", "headers": { "x-test": "1" }, "name": "streamer" }],
  "compare": { "headers": { "add": ["etag"] } },
  "allow": [{ "path": "steps[*].body.uptime", "kind": "ignore", "reason": "Process uptime differs between runs." }]
}
```

## Tests and extension

`dima-rust/tools/check dima-rig` runs the unit tests (normalisation and comparison) and
`tests/selftest.rs`, which drives the real loop with `tests/fixture/server.rs` as both sides:
an equivalent candidate must match, and one candidate per defect must be caught at its path.
It needs the local stores and skips without `DIMA_TEST_MONGO_URI`.

New step kinds (signed webhooks, Socket.IO clients, outside-service mocks) are new optional keys
of a step (`StepFile` and `StepKind` in `src/scenario.rs`, run in `src/steps.rs`, captured as a
`StepCap` in `src/capture.rs`); existing files stay valid. A format change that makes old captures
compare differently bumps `CAPTURE_VERSION`.
