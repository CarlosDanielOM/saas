# dima-rig: the side-by-side rig

`dima-rig` runs the **reference** (the frozen TypeScript) and the **candidate** (the Rust port)
on the same scenario from the same initial state and compares what each one did: every HTTP
response, then the final MongoDB state (typed documents and indexes), then the final Dragonfly
state (keys, types, values, TTLs). Run-time values (generated ids, times, ports) are normalised;
nothing else is forgiven unless a scenario allows it with a reason.

The reference is recorded once per scenario and stored **raw**: exactly what was observed, with
the metadata needed to normalise it later. Every check normalises the stored reference and the
fresh candidate with the current code, so the recordings stay the regression suite after the
TypeScript is deleted, and a better normaliser applies to old recordings too.

Sides never run at the same time. Each side gets its own loopback ports, a fresh MongoDB
database (`rig_<pid>_<n>_<side>`) and its own Dragonfly logical database (1 to 9, claimed with a
file lock, flushed with `FLUSHDB`), seeded identically. **Each scenario gets its own process**,
started after the stores were emptied and seeded, so nothing an earlier scenario left in memory
can change a later one.

```
rig/
  byte_sensitive.json                      Dragonfly keys whose values compare as exact text
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

$RIG record  <target> [scenario...] [--label <commit>]   # run the reference twice, check it is stable, write captures
$RIG verify  <target> [scenario...]      # run the candidate, compare with the captures
$RIG compare <target> [scenario...]      # run both live and compare (no captures involved)
$RIG diff-get <target> --db <name> --paths <list.json> [--allow-writes]   # GET requests over an existing database
$RIG check   <target> [scenario...]      # parse target and scenarios, report stale or missing captures
$RIG gc                                  # drop rig_ databases and users left by rig processes that are gone
```

A scenario argument is a name (`items/create`), a directory (`items`) or a glob (`*/create`).
Options (before or after the command): `--set name=value` fills `{var.name}` in targets;
`--rig-dir`, `--captures-dir`, `--out-dir`; `--mongo-uri`, `--dragonfly host:port`,
`--dragonfly-dbs 1-9`; `--byte-sensitive <file>` (default `byte_sensitive.json` of this crate);
`--report <file>`; `--keep` keeps the side databases for inspection; `record --once` skips the
stability run; `record --label` stores a label (such as the reference's commit id) in each
capture.

Exit code: **0** only when every scenario matched (or was recorded) and no side failed;
**1** differences or a side failure; **2** the rig itself could not run (bad file, store down);
**130** interrupted.

**Cleanup.** Everything a command claims (MongoDB databases, temporary users, Dragonfly logical
databases with their locks) is released by one path, after success, an error of the rig itself
or Ctrl-C alike: databases dropped, users dropped, each logical database flushed and only then
its lock released. Every exit path also kills each side's whole process group, including what a
side started when its own process has already exited. stderr says what was released
(`cleanup: dropped MongoDB databases ...; flushed Dragonfly logical databases ...`).

`record` writes a capture only when it changed: when the stored capture, normalised by the
current code, still matches the new run, the file is left alone (`UNCHANGED`). If the two
reference runs disagree the scenario is `UNSTABLE` and nothing is written: fix the scenario or
add an allowance. A capture stores the hash of its scenario and of every seed it includes;
`verify` refuses a stale capture (`capture is stale ... run dima-rig record`).

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
  chosen per launch. **The first one declared is the primary port**: `{port}`, the ready probe
  and every request without a `port` use it.
- `share_process` (default `false`): the scenarios of a run share one process per side; between
  scenarios the stores go back to the snapshot taken right after it started, then the next seed
  is written, and `restart: true` in a scenario still gives it its own process. Faster, but
  **in-memory state** (caches, counters, timers, open subscriptions) **carries from one scenario
  into the next**, so a scenario's result can depend on which scenarios ran before it, and a
  scenario verified alone can differ from its recording. Use it only for targets with no such
  state.
- `command` (program then arguments), `cwd` (relative to the repository root; default the root)
  and every `env` value are templates. Placeholders: `{port}`, `{port.<name>}`,
  `{mongo_uri}` (root URI with the side's database as its path), `{mongo_root_uri}`,
  `{mongo_db}`, `{dragonfly_host}`, `{dragonfly_port}`, `{dragonfly_db}`, `{dragonfly_url}`
  (`redis://host:port/<db>`), `{side}` (`reference` or `candidate`), `{repo}`, `{rig_dir}`,
  `{cargo_target_dir}`, `{var.<name>}` (from `--set`). `{{` and `}}` are literal braces.
- **The environment is built from `env` only.** Nothing of the rig's own environment leaks in,
  except the names listed in `pass_env`. A bare program name is looked up on the side's `PATH`,
  or the rig's when the side has none.
- `ready`: exactly one of `"http": "/path"` (GET until 2xx, or `"status": <code>`) or
  `"tcp": true`; `port` picks a named port (default the primary one); `timeout_ms` is required.
- `stop`: signal to the whole process group (`SIGTERM` default, `SIGINT`, `SIGQUIT`, `SIGHUP`),
  then `SIGKILL` of the group after `grace_ms` (default 5000).

Each launch logs its output to `out/logs/<target>/<run>-<side>-<n>.log`. When a side fails to
start, dies, or a step fails, the report shows the log's last 30 lines. A side that exits on its
own is always a failure.

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
  "compare": { "mongo": { "exclude": ["logs*"] }, "headers": { "include": ["content-length"] } },
  "allow": [
    { "path": "steps[1].body.tags", "kind": "set", "reason": "Tags come from a Set; the reference does not order them." }
  ]
}
```

Top level: `rig_scenario` (1), `description` (required), `seed`, `steps` (required), `compare`,
`allow`, `restart` (only with `share_process` targets), `allow_scripts` (default `false`),
`tolerance_ms` (default 2000), `relation_tolerance_ms` (default 50).

**Seed.** `mongo` maps collection to documents in **canonical Extended JSON**: every number names
its BSON type (`$numberInt`, `$numberLong`, `$numberDouble`, `$numberDecimal`; a bare number is an
error), dates are `{"$date": "..."}`, ids `{"$oid": "..."}`, and every document needs an explicit
`_id`. A missing field stays missing, `null` is stored as null. `{"$rigNow": "<offset>", "as": ...}`
is the seed time plus an offset (`0`, `+60s`, `-5m`, `150ms`, `+2h`, `+2d`), stored as a date
(default), `long` or `double` (epoch ms), `s` (epoch seconds) or `iso` (string). `dragonfly` is a
list of commands. `include` reads seed files (`{"rig_seed": 1, "description", "include",
"mongo", "dragonfly"}`), paths relative to the including file. Includes run first.

**Steps** run in order; each has an optional `name` and exactly one kind:

| Kind | Fields |
|---|---|
| `http` | `method` (GET POST PUT PATCH DELETE HEAD OPTIONS), `path` (starts with `/`), `port` (a target port name; default the primary one), `headers`, at most one body: `json`, `form` (object or `[[name, value], ...]`, URL-encoded), `text`, `body_base64`; `timeout_ms` (30000); `expect: {"status": 201 \| [200, 204]}`; `save: {"name": "status" \| "headers.<name>" \| "body" \| "body.a[0].b"}` |
| `dragonfly` | `["CMD", "arg", ...]` on the side's logical database; the reply is captured and compared |
| `pause_ms` | a number of milliseconds |
| `wait_for` | `{"mongo": {"collection", "filter", "count"}}` (at least `count`, default 1, documents match) or `{"key": "pattern"}` (a key exists; `*` and `?` allowed), plus `timeout_ms` |
| `wait_quiet` | `quiet_ms` without any MongoDB or Dragonfly change, bounded by `timeout_ms`; `ignore_keys`, `ignore_collections` (globs) |

**Dragonfly commands** (steps and seeds) go through an allow-list (`src/dfcmd.rs`): data commands
on the side's own logical database only. Anything that reaches another database (`SELECT`,
`SWAPDB`, `MOVE`, `COPY ... DB`), affects the server or other clients (`FLUSHALL`, `FLUSHDB`,
`CONFIG`, `SHUTDOWN`, `DEBUG`, `CLIENT`, `PUBLISH`: channels are server-wide), blocks (`BLPOP`,
`XREAD ... BLOCK`) or holds connection state (`MULTI`, `WATCH`, `SUBSCRIBE`) is refused. The
check runs on the **fully rendered** command when the step runs (a saved value can become a
command name), and at load time where the words are literal. `EVAL`, `EVALSHA` and
`SCRIPT LOAD|EXISTS` need `"allow_scripts": true`; `SCRIPT FLUSH|KILL` never run. A script can
still do anything, so it must stay on its keys and **every loop in it must be bounded by an
iteration count**: Dragonfly has no `SCRIPT KILL` and no Lua time limit (MIGRATION.md section 7).

Strings in paths, headers, bodies, commands and filters may use `${name}` (a value saved by an
earlier step), `${now_ms}`, `${now_s}`, `${now_iso}` with an optional offset (`${now_ms+60s}`);
`$${` is a literal `${`. JSON bodies and commands also take `$rigNow` (`as`: `ms` default, `s`,
`iso`), the time the step runs plus the offset. `expect` failing, a wait timing out, or a side
dying fails the scenario (status `ERROR`), on either side. Filters may use bare numbers (MongoDB
compares numbers across types).

**compare** (default: everything): `mongo` and `dragonfly` take `{"only": [globs], "exclude":
[globs]}` over collection names and keys; `headers` is `{"include": [...]}` with names from the
noise list to compare after all (see Normalisation); `as_text: [paths]` keeps Dragonfly strings
at those paths as exact text, like the byte-sensitive keys.

**allow** is a list of `{"path", "kind", "reason"}`; the reason is mandatory. An allowance that
matched nothing is reported as a warning: remove stale ones.

| kind | effect |
|---|---|
| `ignore` | the value at the path is not compared, presence included (also the way to skip a response header) |
| `set` | the array at the path is compared as a multiset |
| `tolerance` | with `"ms"`: times (and plain numbers) at the path compare within that margin; relations of these times too |
| `generated` | the string at the path is a run-time token (numbered like an id); with `"pattern": "<regex>"`, every match inside strings and key names at or below the path |
| `exact` | the path is **not a time**: numbers, dates and strings there compare exactly (a constant date near the run, a number that only looks like epoch milliseconds) |
| `time` | the number (or digit string) at the path **is a time**; `"unit": "s"` for epoch seconds, which magnitude detection does not find; `"ms"` (default) |

## Paths

Reports and allowances address values the same way: `steps[0].status`,
`steps[0].headers.content-type`, `steps[0].headers.set-cookie.sid.samesite`,
`steps[2].body.items[1].name`, `steps[3].reply`, `mongo.items[0].qty` (documents in canonical
order), `mongo.items.indexes.name_1.unique`, `dragonfly["config:greeting"].ttl`,
`dragonfly["item:<oid:1>"].value`, `dragonfly["events"].value[0].fields[1]`,
`mongo.c[0].ключ["🍕 pizza"]`. Keys that are not letters, digits, `_` or `-` are quoted. In
allowance paths `[*]` is any index, a `*` segment is any one key or index, `**` is any depth, and
`*` inside a key matches any run (`created*`, `["item:*"]`).

## Normalisation

Applied to both sides every time they are compared, never stored.

- **Generated ids.** An ObjectId whose timestamp falls in the side's lifetime, a v4 UUID (or a v7
  inside the lifetime), and values named by a `generated` allowance become numbered placeholders:
  `<oid:1>`, `<uuid:1>`, `<gen:1>`. One map per side across the whole capture (responses in step
  order, then MongoDB by collection, then Dragonfly), including inside strings and key names.
  Comparison binds reference `<oid:n>` to candidate `<oid:m>` on first meeting; any later
  disagreement is a `cross-reference differs` difference. Object keys holding generated values
  pair by key **and value** together first, so equivalent objects whose generated keys come in
  another order match. Ids that appear in the scenario's inputs (seed, paths, bodies, commands)
  compare exactly. A `generated` value spreads to other places only as a whole value or a whole
  token (not glued to letters or digits), never as a bare substring, and never onto a value known
  from the inputs; a known value is not generated even at the named path.
- **Order.** Documents and keys are sorted by content with generated values masked, so runs that
  differ only in generated values normalise identically. Documents and keys pair by content,
  identity, then similarity (Dragonfly entries named alike by the similarity of their values), so
  one extra document is one difference.
- **Times.** BSON dates, ISO strings (inside any string; the format is kept as a shape such as
  `dddd-dd-ddTdd:dd:dd.dddZ`), `YYYY-MM-DD` days, epoch-millisecond numbers (int64, double, JSON,
  13-digit runs in strings), HTTP dates in headers and TTLs within 400 days of the run become
  **relative to the side's own run start** (just before the first step: the time a process takes
  to start does not move them) and compare within `tolerance_ms`, never by absolute equality
  with the other side (a replayed timestamp is a difference; declare a constant date near the
  run with `exact`). Values the seed wrote with `$rigNow` are recognised exactly and compare by
  their seed offset (`seed+60000ms`). Times in the inputs, and times farther away, compare
  exactly. "No TTL" versus a TTL, a date versus an epoch number, and a different ISO format are
  differences. Each TTL is relative to the moment it was read.
- **Relations between times.** Within one unit (a MongoDB document, a response, a Dragonfly entry
  with its TTL, a reply) the times must relate as in the reference: equal times (one clock
  reading used twice) stay equal; a difference of a whole number of seconds, at least one
  (a lease or expiry computed as now plus a constant), stays that duration within
  `relation_tolerance_ms` (50); otherwise the order stays (a gap within the relation tolerance
  may close on a faster candidate, never reverse). Times with one-second precision (epoch
  seconds, HTTP dates, ISO without milliseconds, TTLs) count only by order, and only when more
  than a second apart. This catches a missing `updatedAt` bump or a lease of the wrong length
  that the window tolerance lets through. A path that already differs is not reported again
  through its relations. If `record` reports a relation as `UNSTABLE`, two operations of the
  scenario ran within the same millisecond or a whole second apart by chance: separate them
  with a `pause_ms`.
- **Headers.** Every response header is compared except a noise list: `date`, `connection`,
  `keep-alive`, `transfer-encoding`, `content-length`, `x-powered-by` (`compare.headers.include`
  brings one back; an `ignore` allowance with a reason drops another). A repeated header is an
  array in order. `etag` compares by presence and weak/strong form only (its value derives from
  a body holding generated values). `set-cookie` becomes an object per cookie name: `value`
  (generated values normalised) and each attribute by its lower-case name (`true` for flags,
  `expires` as a time).
- **Ports and the side's database names** become `<run:port.http>`, `<run:mongo_db>`,
  `<run:dragonfly_url>`.
- **JSON** (bodies, stored JSON): object key order is a note, not a failure; numbers compare by
  value (`5` = `5.0`, with a note inside stored JSON). **BSON** numbers compare by type and value.
  Arrays are ordered unless allowed as a `set`; Dragonfly sets and sorted sets are unordered.
- **Dragonfly.** Key names, hash fields, members and values that are not UTF-8 are bytes, which
  never equal any text (ids in the UTF-8 parts of a key are still found). Stream entries keep
  their fields as ordered pairs, so a repeated field name counts. Values of **byte-sensitive
  keys** compare as exact text (below).
- **Never forgiven:** missing versus null, empty string versus missing, string versus number, a
  different BSON type, an extra or missing document, field, key, index or collection, a different
  status, header, body, TTL class, index key order or index option.

## Byte-sensitive keys

`byte_sensitive.json` lists Dragonfly key globs (`*` matches any run) whose values a reader
compares byte by byte: queue items removed by value, JSON compared inside Lua, hashed payloads
(MIGRATION.md section 7 rule 6). For these keys (and replies to commands on them) a value is never
parsed as JSON: key order, number text, escaping and whitespace all count; only generated ids
and times inside are normalised. Every other value holding compact JSON is parsed and compared
by value, key order being a note. The list was seeded from the `byteSensitive` section of
`ledger/dragonfly.json`; each entry names its ledger key id and why:

```json
{ "pattern": "cron:jobs:queue", "ledger": "q.cronjobs", "type": "list", "why": "CronQueueJob JSON" }
```

When a package finds another value that a reader compares byte by byte, add an entry here (and
in the ledger). Because captures are raw, the new rule also applies to everything already
recorded. `--byte-sensitive <file>` uses another list.

## Captures

`captures/<target>/<scenario>.json`, `"rig_capture": 2`. Raw and stable (stored order is
deterministic: documents by `_id` then content, indexes by name, keys by bytes, hash fields and
set members by bytes; lists, streams and sorted sets in their own order):

```json
{
  "rig_capture": 2, "target": "selftest", "scenario": "items/create",
  "provenance": { "side": "reference", "label": "3c162c9f", "recorded_at": "2026-...Z", "rig_version": "0.1.0" },
  "hashes": { "scenario": "fnv1a64:...", "files": { "items/create.json": "fnv1a64:...", "_seeds/users.json": "fnv1a64:..." } },
  "run": { "seeded_at": 1794..., "start": 1794..., "end": 1794..., "process_start": 1794...,
           "ports": { "http": 41234 }, "mongo_db": "rig_123_0_ref", "mongo_uri": "mongodb://127.0.0.1:27017/rig_123_0_ref?...",
           "dragonfly_db": 3, "dragonfly_url": "redis://127.0.0.1:6379/3" },
  "steps": [
    { "http": { "at": 1794..., "status": 201, "headers": [["content-type", "application/json"], ...], "body": "{\"id\":...}" } },
    { "dragonfly": { "at": 1794..., "command": ["HGETALL", "items:by-name"], "reply": { "array": [{ "bulk": "..." }] } } },
    { "pause_ms": {} }
  ],
  "mongo": { "items": { "type": "collection", "options": {}, "indexes": [ ... ], "documents": [ ... ] } },
  "dragonfly": [ { "key": "item:65...", "type": "string", "pttl": 3599120, "pttl_at": 1794..., "value": "{\"id\":...}" } ]
}
```

Documents, index definitions and options are canonical Extended JSON, or
`{"$rigBson": "<base64>"}` (the BSON bytes) when Extended JSON would not read back identically.
Bytes (header values, bodies, keys, fields, members, values) are a JSON string when they are
UTF-8 and `{"$rigBytes": "<base64>"}` otherwise. Replies are `null` or one of `int`, `bulk`,
`status`, `error`, `array`, `double`, `bool`, `map`. Credentials are never stored. The format
version changes only when old files cannot be read any more; a normalisation change needs no
re-recording.

## Reports

Text on stdout, JSON in `out/report-<command>-<target>.json` (or `--report`):

```
DIFFER    items/lease (1 difference)
  mongo.items[0].updatedAt: time relation to mongo.items[0].createdAt differs: reference +126ms after it, candidate the same time
      in document _id {"$oid":"<oid:1>"}
      reference: +126ms after it
      candidate: 0ms after it
```

Statuses: `MATCH`, `DIFFER`, `ERROR` (a side failed or the scenario is invalid; the log tail
follows), `RECORDED`, `UNCHANGED`, `UNSTABLE`, `CHECKED`. JSON: `{"rig_report": 1, "command",
"target", "ok", "scenarios": [{"scenario", "status", "differences": [{"path", "what",
"reference", "candidate", "context"}], "notes", "warnings", "errors": [{"side", "step",
"message", "log", "log_tail"}]}], "errors", "warnings"}`.

## diff-get (real data)

Both sides read an existing database (for example the local `domdimabot` copy) with their own
Dragonfly logical database; each request is one report entry. **Each side gets a temporary
MongoDB user** (`rig_<pid>_<n>_<side>_ro`, defined in `admin`, role `read` on that database
only), created for the run and dropped by the cleanup path, so a side cannot change what the
other then reads. The rig also compares the database's `dbHash` and index lists before and after
each side and fails a side that wrote (`--no-write-check` skips this). A target that cannot
start with read-only credentials (it creates indexes at start-up, for example) is told so;
`--allow-writes` then gives both sides the rig's own credentials, and the report says that
writes were possible. When the server does not enforce authentication, the report says that too.

```json
{
  "rig_get_list": 1,
  "description": "Public read endpoints over the local production copy",
  "headers": { "accept": "application/json" },
  "requests": ["/api/health", { "path": "/api/streamers/foo", "headers": { "x-test": "1" }, "name": "streamer" }],
  "compare": { "headers": { "include": ["content-length"] } },
  "allow": [{ "path": "steps[*].body.uptime", "kind": "ignore", "reason": "Process uptime differs between runs." }]
}
```

## What the rig cannot see

- Calls to outside services, Socket.IO and WebSocket traffic, pub/sub messages, webhooks and
  emails: not captured yet (mocks and outbound comparison come in a later package).
- Anything not in the final state: intermediate MongoDB or Dragonfly states between steps, keys
  that expired or were deleted before the capture, the order in which writes happened, and
  how many times a value was written. A `dragonfly` step can read a value mid-scenario.
- Timing and performance: latency, timeouts, retries, and work done after the last step unless
  a `wait_for` or `wait_quiet` step waits for it.
- Concurrency: races between processes and two writers on the same data (fault scenarios).
- Times within the window tolerance of each other (2 s) that relate to nothing else in their
  unit; durations that are not a whole number of seconds (only their order is checked); times
  with one-second precision closer than a second.
- Values the seed wrote with `$rigNow` that the application shifts by its own amount (they are
  run times then, and the process start adds jitter).
- Anything a scenario does not exercise, collections and keys excluded by `compare`, and paths
  an allowance ignores.
- Logs, stdout and the process exit status beyond "did not die".

## Tests and extension

`dima-rust/tools/check dima-rig` runs the unit tests (normalisation and comparison), the store
inspection test (`tests/stores.rs`) and `tests/selftest.rs`, which drives the real loop with
`tests/fixture/server.rs` as both sides: an equivalent candidate must match, and one candidate
per seeded defect must be caught at its path with nothing else reported. It also proves the
cleanup after a failure and after Ctrl-C, the command allow-list, process isolation, and that
a recording re-verified with another normalisation setting is normalised again. It needs the
local stores and skips without `DIMA_TEST_MONGO_URI`.

Worktrees share one cargo target directory, where cargo gives this crate the same artifact names
in every checkout: another worktree building `dima-rig` at the same time replaces the binaries
the self-test runs. The self-test refuses binaries built from another checkout; rerun, or set a
private `CARGO_TARGET_DIR` for `tools/cargo`.

New step kinds (signed webhooks, Socket.IO clients, outside-service mocks) are new optional keys
of a step (`StepFile` and `StepKind` in `src/scenario.rs`, run in `src/steps.rs`, stored raw as a
`RawStep` and normalised in `src/detect.rs`); existing files stay valid. Bump `CAPTURE_VERSION`
only when old captures cannot be read any more.
