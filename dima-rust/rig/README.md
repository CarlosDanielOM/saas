# dima-rig: the side-by-side rig

`dima-rig` runs the **reference** (the frozen TypeScript) and the **candidate** (the Rust port)
on the same scenario from the same initial state and compares what each one did: every HTTP
response, then the final MongoDB state (typed documents and indexes), then the final Dragonfly
state (keys, types, values, TTLs), then **every call it made to the outside world**, which a
local mock answers (see [The mock of the outside world](#the-mock-of-the-outside-world)).
Run-time values (generated ids, times, ports) are normalised; nothing else is forgiven unless a
scenario allows it with a reason.

The reference is recorded once per scenario and stored **raw**: exactly what was observed, with
the metadata needed to normalise it later. Every check normalises the stored reference and the
fresh candidate with the current code, so the recordings stay the regression suite after the
TypeScript is deleted, and a better normaliser applies to old recordings too.

Sides never run at the same time. Each side gets its own loopback ports, a fresh MongoDB
database (`rig_<pid>_<n>_<side>`) reached with a MongoDB user that may use only that database,
its own Dragonfly logical database (1 to 9, claimed with a file lock, flushed with `FLUSHDB`),
its own mock, its own view of the local Qdrant (a collection-name prefix) and its own data
directory, all seeded identically. **Each scenario gets its own process**, started after the
stores were emptied and seeded, so nothing an earlier scenario left in memory can change a later
one.

```
rig/
  byte_sensitive.json                      Dragonfly keys whose values compare as exact text
  mock/providers.json                      every outside service: hosts, comparison, default routes
  node/preload.mjs                         confines a Node reference to its mock (NODE_OPTIONS=--import)
  node/cron_index_stub.sh                  stands in for the native cron index the reference image lacks
  targets/<target>.json                    how to launch each side (dimadb, dimabot-api, dimabot-bot, dimabot-cron)
  scenarios/<target>/<area>/<name>.json    what to do (one scenario per file)
  scenarios/<target>/_seeds/*.json         reusable seed files (names starting with _ are not scenarios)
  captures/<target>/<area>/<name>.json     recorded reference captures (committed)
  out/                                     logs, reports and side data directories (git-ignored)
  tests/selftest-rig/                      the self-test targets (selftest, hooks), complete small examples
  tests/confine-rig/                       the confinement probe for the reference image
```

## Commands

```sh
eval "$(dima-rust/tools/test-env)"       # DIMA_TEST_MONGO_URI, DIMA_TEST_DRAGONFLY, DIMA_TEST_QDRANT_URL
R=dima-rust/tools/cargo; $R build -p dima-rig
RIG=dima-rust/target/debug/dima-rig      # tools/cargo builds each checkout into its own target/

$RIG record  <target> [scenario...] [--label <commit>]   # run the reference twice, check it is stable, write captures
$RIG verify  <target> [scenario...]      # run the candidate, compare with the captures
$RIG compare <target> [scenario...]      # run both live and compare (no captures involved)
$RIG diff-get <target> --db <name> --paths <list.json> [--allow-writes]   # GET requests over an existing database
$RIG check   <target> [scenario...]      # parse target and scenarios, report stale or missing captures
$RIG gc                                  # drop rig_ databases, users and Qdrant collections left by rig processes that are gone
$RIG mock [--port N] [--routes f.json] [--qdrant]   # one mock in the foreground, printing every request
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

**Cleanup.** Everything a command claims (side containers, MongoDB databases, temporary users,
Qdrant collections, data directories, Dragonfly logical databases with their locks) is released
by one path, after success, an error of the rig itself or Ctrl-C alike: containers removed
first (nothing may write while the rest is released), databases and users dropped, collections
deleted, each logical database flushed and only then its lock released. Every exit path also
kills each side's whole process group, including what a side started when its own process has
already exited. stderr says what was released (`cleanup: dropped MongoDB databases ...; dropped
Qdrant collections ...; removed containers ...; flushed Dragonfly logical databases ...`).

The Qdrant API key comes from `DIMA_RIG_QDRANT_API_KEY` or `DIMA_TEST_QDRANT_API_KEY`, else
from the running `qdrant` container (`docker exec qdrant printenv QDRANT__SERVICE__API_KEY`, as
`tools/test-env` reads the MongoDB credentials); the URL from `DIMA_RIG_QDRANT_URL` or
`DIMA_TEST_QDRANT_URL` (loopback only).

`record` writes a capture only when it changed: when the stored capture, normalised by the
current code, still matches the new run, the file is left alone (`UNCHANGED`); otherwise the
report lists what changed against it. If the two reference runs disagree the scenario is
`UNSTABLE` and nothing is written: fix the scenario or add an allowance. A capture stores the hash of its scenario and of every seed it includes;
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
  state. A single scenario can say `"share_process": true` instead (it does not depend on
  process state): consecutive scenarios that say so share one process. The mock is reset for
  each scenario; the Qdrant collections and the data directory are not.
- `command` (program then arguments), `cwd` (relative to the repository root; default the root)
  and every `env` value are templates. Placeholders: `{port}`, `{port.<name>}`,
  `{mongo_uri}` (the side's own user and database), `{mongo_root_uri}`, `{mongo_hostport}`,
  `{mongo_db}`, `{dragonfly_host}`, `{dragonfly_port}`, `{dragonfly_db}`, `{dragonfly_url}`
  (`redis://host:port/<db>`), `{mock_url}` and `{mock_port}` (the side's mock),
  `{qdrant_port}` and `{qdrant_api_key}` (the side's Qdrant proxy and the placeholder key it
  accepts), `{data_dir}`, `{side}` (`reference` or `candidate`), `{repo}`, `{rig_dir}`,
  `{cargo_target_dir}` (default each checkout's `dima-rust/target`), `{var.<name>}` (from
  `--set`). `{{` and `}}` are literal braces.
- `container` instead of `command`: `{"image", "command", "mounts": [[host, container, "ro"?]],
  "memory_mb" (1024), "cpus" (2), "workdir"}` runs `docker run --rm --init --network host
  --name rig-<pid>-<db>-<side>-<n> --label dima-rig=<pid> --memory ... --cpus ...` with every
  `env` name passed as `--env NAME` (values never on a command line). `--network host` so
  `127.0.0.1` reaches the stores and the mock; servers inside must listen on 127.0.0.1 (the
  Node preload does that). The container is removed when the side stops, when the rig drops it,
  and by the cleanup path. Only images the lead built are run; the rig never builds one.
- `unavailable: "<why>"` (candidate only) describes a side that does not exist yet: `record` and
  `check` work, `verify`, `compare` and `diff-get` refuse with that reason.
- **The environment is built from `env` only.** Nothing of the rig's own environment leaks in,
  except the names listed in `pass_env`. A bare program name is looked up on the side's `PATH`,
  or the rig's when the side has none.
- `ready`: exactly one of `"http": "/path"` (GET until 2xx, or `"status": <code>`),
  `"tcp": true`, `"log": "<regex>"` (the side's output matches; for processes without a port),
  `"mongo": {"collection", "filter", "count"}` or `"key": "<glob>"` (a Dragonfly key exists);
  `port` picks a named port (default the primary one); `timeout_ms` is required. After it, the
  rig waits until the stores were quiet for 200 ms and the mock for 300 ms (`mock.settle_ms`
  bounds it, default 3000), ignoring what the scenario does not compare.
- `stop`: signal to the whole process group (`SIGTERM` default, `SIGINT`, `SIGQUIT`, `SIGHUP`),
  then `SIGKILL` of the group after `grace_ms` (default 5000).

- `mock`: the mock section for every scenario of the target (routes, Twitch and S3 seeds,
  `startup`, `settle_ms`, `compare` with `compare_reason`; see the mock section). Scenario
  routes come first, then the target's, then the provider defaults.
- `qdrant: true`: each side gets a prefixing proxy to the local Qdrant (`{qdrant_port}`).
- `webhooks`: `{"eventsub": {"secret", "port", "path"}, "polar": {...}}`: where the `eventsub`
  and `polar` steps deliver and the side's test secret they sign with (a template).
- `mongo_user`: `side` (default: a user with `readWrite` and `dbAdmin` on the side's database
  only, created for the run and dropped after it) or `rig` (the rig's own credentials, with a
  `mongo_user_reason`; `dimadb` keeps it because its console shows the connection user and its
  captures were recorded that way).

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
`allow`, `mock` (see the mock section), `restart` (only with shared processes),
`share_process` (default `false`), `allow_scripts` (default `false`), `tolerance_ms` (default
2000), `relation_tolerance_ms` (default 50).

**Seed.** `mongo` maps collection to documents in **canonical Extended JSON**: every number names
its BSON type (`$numberInt`, `$numberLong`, `$numberDouble`, `$numberDecimal`; a bare number is an
error), dates are `{"$date": "..."}`, ids `{"$oid": "..."}`, and every document needs an explicit
`_id`. A missing field stays missing, `null` is stored as null. `{"$rigNow": "<offset>", "as": ...}`
is the seed time plus an offset (`0`, `+60s`, `-5m`, `150ms`, `+2h`, `+2d`), stored as a date
(default), `long` or `double` (epoch ms), `s` (epoch seconds) or `iso` (string). `dragonfly` is a
list of commands. `files` writes files into the side's data directory (`{data_dir}`) before the
process starts: `{"conf/app.json": {"json": ...} | {"text": "..."} | {"base64": "..."}}`,
relative paths only; the directory is emptied before each launch. `include` reads seed files
(`{"rig_seed": 1, "description", "include", "mongo", "dragonfly", "files"}`), paths relative to
the including file. Includes run first.

**Steps** run in order; each has an optional `name` and exactly one kind:

| Kind | Fields |
|---|---|
| `http` | `method` (GET POST PUT PATCH DELETE HEAD OPTIONS), `path` (starts with `/`), `port` (a target port name; default the primary one), `headers`, at most one body: `json`, `form` (object or `[[name, value], ...]`, URL-encoded), `text`, `body_base64`; `timeout_ms` (30000); `expect: {"status": 201 \| [200, 204]}`; `save: {"name": "status" \| "headers.<name>" \| "body" \| "body.a[0].b"}` |
| `dragonfly` | `["CMD", "arg", ...]` on the side's logical database; the reply is captured and compared |
| `pause_ms` | a number of milliseconds |
| `wait_for` | `{"mongo": {"collection", "filter", "count"}}` (at least `count`, default 1, documents match) or `{"key": "pattern"}` (a key exists; `*` and `?` allowed), plus `timeout_ms` |
| `wait_quiet` | `quiet_ms` without any MongoDB or Dragonfly change, bounded by `timeout_ms`; `ignore_keys`, `ignore_collections` (globs) |
| `eventsub` | a Twitch EventSub delivery to the target's `webhooks.eventsub` (see below); its answer compares like an `http` step |
| `polar` | a Polar webhook (standardwebhooks) to `webhooks.polar`; its answer compares like an `http` step |
| `wait_call` | `{"host": "api.twitch.tv"}` or `{"provider": "twitch"}`, plus `method`, `path` (with `*`, `**`, `{name}`), `query`, `body` (JSON fields), `body_contains`, `count` (default 1), `timeout_ms`: until the mock has seen that many matching calls; on timeout the error names the call and the latest ones |

**`eventsub`**: `type`, `version` (default `1`), `condition`, `event`, `message_type`
(`notification` default, `webhook_callback_verification`, `revocation`), `message_id` (default
derived from the scenario and the step, the same on both sides and every run), `timestamp`
(default now, RFC 3339 with nanoseconds as Twitch sends it; ISO text or `{"$rigNow": ...,
"as": "iso"}`), `retry` (`Twitch-Eventsub-Message-Retry`, default 0), `subscription` (fields over
the generated subscription object), `challenge` (verification; default derived). The body is
`{"subscription", "event"}` (or `{"challenge", "subscription"}`, `{"subscription"}`), signed
`sha256=` + HMAC-SHA256(secret, id + timestamp + body) with `dima-core`'s implementation;
headers `Twitch-Eventsub-Message-Id`, `-Retry`, `-Type`, `-Signature`, `-Timestamp`,
`-Subscription-Type`, `-Subscription-Version`.
**`polar`**: `type`, `data`, `id` (`webhook-id`, default derived), `timestamp_s` (default now);
body `{"type", "timestamp", "data"}` signed `v1,<base64>` with the secret's UTF-8 bytes as the
key, as `@polar-sh/sdk` 0.42.5 configures standardwebhooks. Both take `secret` or `signature`
(bad-signature cases), `headers` (a `null` value leaves a header out), `raw` (the exact body: a
string as is, JSON compact), `port`, `path`, `timeout_ms`, `expect`, `save`.

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
earlier step), side values (`${port.http}`, `${mongo_db}`, `${dragonfly_db}`,
`${dragonfly_url}`, `${mock_url}`, `${mock_port}`, `${qdrant_port}`, `${side}`, `${var.x}`;
reserved, a step cannot save under them), `${now_ms}`, `${now_s}`, `${now_iso}` with an optional
offset (`${now_ms+60s}`); `$${` is a literal `${`. A Dragonfly argument that is not UTF-8 is
written `{"$rigBytes": "<base64>"}` (no script needed). JSON bodies and commands also take `$rigNow` (`as`: `ms` default, `s`,
`iso`), the time the step runs plus the offset. `expect` failing, a wait timing out, or a side
dying fails the scenario (status `ERROR`), on either side. Filters may use bare numbers (MongoDB
compares numbers across types).

**compare** (default: everything): `mongo` and `dragonfly` take `{"only": [globs], "exclude":
[globs]}` over collection names and keys; `headers` is `{"include": [...]}` with names from the
noise list to compare after all (see Normalisation); `as_text: [paths]` keeps Dragonfly strings
at those paths as exact text, like the byte-sensitive keys; `calls` is `{"<provider>":
"ordered" | "multiset" | "ignore"}`; `call_headers` is `{"include": [...]}`, more request
headers of outbound calls to compare.

**allow** is a list of `{"path", "kind", "reason"}`; the reason is mandatory. An allowance that
matched nothing is reported as a warning: remove stale ones.

| kind | effect |
|---|---|
| `ignore` | the value at the path is not compared, presence included (also the way to skip a response header) |
| `set` | the array at the path is compared as a multiset |
| `tolerance` | with `"ms"`: times (and plain numbers) at the path compare within that margin; relations of these times too |
| `generated` | the string at the path is a run-time token (numbered like an id); with `"pattern": "<regex>"`, every match inside strings and key names at or below the path |
| `exact` | the path is **not a time**: numbers, dates and strings there compare exactly (a constant date near the run, a number that only looks like epoch milliseconds) |
| `time` | the number (or digit string) at the path **is a time**; `"unit": "s"` for epoch seconds, which magnitude detection does not find; `"ms"` (default); `"min"` for whole epoch minutes (`floor(now / 60 s)`, a rate-limit window), compared within at least 61 s |
| `ttl` | the number at the path is a **remaining duration** when the answer was read (a TTL field): compared as the moment it ends, relative to the run; `"unit": "s"` (default) or `"ms"`; negative values (no TTL, no key) stay numbers |

A `tolerance` allowance also relaxes "one clock reading" (two times that must be equal) on its
path to that margin: two separate clock readings that usually fall in the same millisecond.

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
  differences. Each TTL is relative to the moment it was read. A date-only constant in a request
  is an input together with its UTC midnight, and epoch seconds in a request also as
  milliseconds, so the date or time the application stores from them compares exactly.
- **Start-up.** In a scenario with its own process, a time written after the process started
  and before the first step was **written during start-up**: it compares as such (both sides
  wrote it during start-up; how long a start-up takes is not behaviour, and a Rust side starts
  in milliseconds where Node takes seconds); one side during start-up and the other during the
  run is a difference. A Dragonfly key that already had a TTL when the start-up settled, and
  still expires as then, was given that TTL during start-up: its TTL length is only known to lie
  between "expiry minus the run start" and "expiry minus the process start", and the two sides'
  ranges must overlap within `tolerance_ms`. Keys the seed gave a TTL are not start-up keys.
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

`captures/<target>/<scenario>.json`, `"rig_capture": 3` (version 2 files, without calls, still
read: the committed `dimadb` captures are version 2). Raw and stable (stored order is
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

Format 3 adds `run.mock_port`, `run.qdrant_port`, `run.qdrant_prefix` (masked as
`<run:port.mock>`, `<run:port.qdrant>`, `<run:qdrant_prefix>` wherever they appear), Dragonfly
command arguments as bytes, `calls` (every request to the mock in arrival order: `at`,
`provider`, `host`, `method`, `path`, `query`, every header with credential values reduced to
their scheme, the body as received, `answered`), `startup_ignored` (start-up calls left out,
counted per provider) and `startup_keys` (keys with a TTL when the start-up settled, and their
expiry then).

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

- Socket.IO and raw WebSocket traffic, SSE streams the side serves, and pub/sub messages: not
  captured yet (the next rig package). Outbound calls, webhooks and emails are (through the
  mock); start-up calls only when a scenario sets `mock.startup` to `compare`.
- Qdrant state: requests through the proxy are recorded but not compared, and the collections'
  content is not captured.
- What a provider would have answered: the mock answers what the scenario and the provider
  table say. A provider behaviour the mock does not model (Twitch's EventSub verification
  round-trip, rate limiting that kicks in) is tested only as far as a scenario routes it.
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

`dima-rust/tools/check dima-rig` runs the unit tests (normalisation and comparison, the mock's
routes and handlers, MessagePack, call comparison), the store inspection test
(`tests/stores.rs`), `tests/mock.rs` (the mock over HTTP: Twitch tokens and EventSub,
Nth-call answers, streams, drops and stalls, unknown hosts and unmatched routes, redaction,
proxying, S3, the Qdrant proxy against the local Qdrant), `tests/webhooks.rs` (the `hooks`
target: signed EventSub and Polar deliveries, `wait_call`, a changed and a missing chat answer
caught, seeded data files, the own-database MongoDB user refusing another database, binary
arguments), `tests/confine.rs` (the confinement proof; needs the reference image) and
`tests/selftest.rs`, which drives the real loop with
`tests/fixture/server.rs` as both sides: an equivalent candidate must match, and one candidate
per seeded defect must be caught at its path with nothing else reported. It also proves the
cleanup after a failure and after Ctrl-C, the command allow-list, process isolation, and that
a recording re-verified with another normalisation setting is normalised again. It needs the
local stores and skips without `DIMA_TEST_MONGO_URI`. Its scenarios use a 10 s window
(`tolerance_ms`): the local stores and CPUs are shared with other suites, which can stall one
request for seconds. The unit tests pin the 2 s default, and the seeded time defects are caught
through relations, which such stalls do not move.

`tools/cargo` builds each checkout into its own `dima-rust/target`. The self-test still refuses
binaries built from another checkout, in case a shared `CARGO_TARGET_DIR` is set.

New step kinds (Socket.IO clients, SSE readers) are new optional keys of a step (`StepFile` and `StepKind` in `src/scenario.rs`, run in `src/steps.rs`, stored raw as a
`RawStep` and normalised in `src/detect.rs`); existing files stay valid. Bump `CAPTURE_VERSION`
only when old captures cannot be read any more.

## The mock of the outside world

Every side gets its own mock: one HTTP/1.1 server on a free loopback port (`{mock_url}`) that
stands in for every provider the backend calls (`ledger/outbound.md`). The first path segment of a
request names the real host, so a Node call rewritten by the preload and a Rust base-URL override
(`ProviderRegistry::base_url_override("twitch", "{mock_url}/api.twitch.tv")`) land on the same
route:

```
http://127.0.0.1:<mock>/api.twitch.tv/helix/users?login=rig      -> provider twitch, path /helix/users
http://127.0.0.1:<mock>/lfm2.5-embeddings:8080/v1/embeddings      -> provider embeddings
http://127.0.0.1:<mock>/rig-media.nyc3.digitaloceanspaces.com/k   -> provider s3 (virtual-hosted)
```

A request names its host with its port when it is not the default (`dima-server:3000`). Absolute
URIs (a child process using the proxy variables) are routed the same way; `CONNECT` is refused.
`dima-rig mock` runs one in the foreground and prints every request and problem.

**Providers** (`mock/providers.json`, built into the binary; how realistic the defaults are):

| Provider | Hosts | Default behaviour |
|---|---|---|
| `twitch` | api.twitch.tv | Stateful: users, tokens and subscriptions from `mock.twitch`. Helix answers 401 without a known token and a `Client-Id`. `helix/users` (by id, login, or the token's user), `channels` (from the users, plus a `channel` object), EventSub subscriptions create (202, 409 on a duplicate, transport secret never echoed) / list (filters, cursor pagination at `page_size`) / delete, `chat/messages` (a message id per request), announcements (204), empty lists for streams, followers, subscriptions, moderators, VIPs, chatters, badges, editors. Every answer carries `Ratelimit-Limit/Remaining/Reset`. Anything else: 501 |
| `twitch-id` | id.twitch.tv | `oauth2/token`: client credentials (one stable app token per client id, accepted by Helix), refresh (rotates access and refresh tokens; unknown → 400), authorization code (the token whose `code` matches); `oauth2/validate` (user or app token, 401 otherwise) |
| `openrouter` | openrouter.ai | chat completions (the request's model; streamed as SSE with an `: OPENROUTER PROCESSING` comment, word chunks, usage and `[DONE]` when `stream: true`; `args.content`, `args.tool_calls`), embeddings (deterministic unit vectors from the text, 4096 dimensions or the request's), the model list, generation stats |
| `minimax` | api.minimax.io | `anthropic/v1/messages` as Anthropic SSE (message_start ... message_stop) or JSON |
| `fish-audio` | api.fish.audio | `v1/tts` returns a silent MP3 frame; the model catalogue is empty, a model id is 404 |
| `polar` | api.polar.sh, sandbox-api.polar.sh | events ingest, empty paginated lists (benefit grants, subscriptions, orders, checkouts, events), customer / checkout / customer-session creation echoing the request. Money: a scenario that depends on Polar's answer declares it |
| `resend` | api.resend.com | `emails` returns an id |
| `posthog` | us.i.posthog.com (and app., eu.) | batch / capture / flags / decide; compared as a multiset |
| `otlp-logs` | (`/i/v1/logs` on the PostHog host) | accepted; recorded, not compared |
| `otel-local` | localhost:4318 | the Node SDK's implicit trace and metric exporter; recorded, not compared |
| `s3` | nyc3.digitaloceanspaces.com, *.nyc3.digitaloceanspaces.com | a stateful object store per scenario (`mock.s3.objects` seeds it): PUT (ETag = MD5), GET, HEAD, DELETE, `POST ?delete` (DeleteObjects XML), path style and virtual-hosted alike |
| `piper` | piper-tts:5000 | `synthesize` returns 0.1 s of silent WAV |
| `embeddings` | lfm2.5-embeddings:8080 | OpenAI-shaped, deterministic 1024-dimension vectors |
| `docs` | dimadocs | `llms.txt`, `llms-full.txt` (en, es): a small fixed text |
| `searxng` | search.myhomelab.wtf | an empty result set |
| `streamelements` | cdn./static.streamelements.com | no default |
| `dimabot-api` | dima-server:3000, api.domdimabot.com | no default; the API target forwards both to its own port (`proxy`) |
| `dima-analytics`, `hoststats` | dima-analytics:3210, dima-hoststats:3211 | no default |
| `legacy-local` | localhost:3355 | the connection is dropped, as at a closed port |
| `qdrant` | (the proxy) | not mocked; see below |

StreamElements' REST API is not used anywhere (ledger), so only its CDN hosts are known.

**Routes** (provider defaults, a target's `mock.routes`, a scenario's `mock.routes`; the
scenario's come first, then the target's, then the defaults; the first that matches answers):

```json
{ "host": "api.twitch.tv", "method": "POST", "path": "/helix/raids", "query": { "from_broadcaster_id": "1001" },
  "headers": { "client-id": "*" }, "body": { "reason": "x" }, "body_contains": "raid", "call": 2,
  "respond": { "status": 429, "headers": { "ratelimit-reset": "${now_s+5s}" }, "json": { "error": "Too Many Requests" },
               "delay_ms": 0 },
  "reason": "The second raid hits the rate limit." }
```

- Matching: `host` (glob; required outside the provider table), `method`, `path` (exact; `*` one
  segment, `{name}` one segment captured, `**` the rest; a trailing slash does not matter),
  `query` and `headers` (each listed name: exact value, `"*"` present, `null` absent), `body`
  (JSON subset: listed fields equal, arrays exact, numbers by value; forms and MessagePack are
  read as objects; gzip is undone), `body_contains` (text). `call: 2` or `[2, 3]` answers only the
  Nth requests that meet the other conditions (counted per route from the scenario start); a
  later route answers the others.
- Answers: exactly one of `respond`, `handler` (with `args`) or `proxy` (`"port.http"`: forward to
  the side's own port). `respond` takes `status` (default 200, 204 without a body), `headers`,
  one of `json`, `text`, `base64`, `sse` (each element one `data:` event, a string as is, anything
  else as JSON), `chunks` (raw pieces, `chunk_delay_ms` between them), `delay_ms`, and `fail`:
  `drop` (close the connection without an answer), `timeout` (never answer), `truncate` (headers
  and the first chunk, then close). Strings in answers take `${now_ms}`, `${now_s}`,
  `${now_iso}` (with offsets), `${id}` (a UUID-v4-shaped id derived from the request content and
  how many identical requests came before: the same on both sides), `${call}`, `${path.<name>}`,
  `${query.<name>}`, `${body.a.b}`; a string that is only one expression keeps the value's JSON
  type.
- A route's `provider` records the call under another provider (one host, two services).
- Handlers: `twitch.users`, `twitch.channels`, `twitch.oauth.token`, `twitch.oauth.validate`,
  `twitch.eventsub.create|list|delete`, `twitch.chat.send`, `paginate` (`args.items`,
  `page_size`, `data_key`, `extra`), `openai.chat`, `openai.embeddings`, `anthropic.messages`,
  `s3`, `wav`, `mp3`.

**The `mock` section** of a target or scenario: `routes`, `twitch` (`client_id`; `users` (Helix
user objects; missing fields get defaults; a `channel` object feeds `helix/channels`); `tokens`
(`token`, `user_id` or none for an app token, `scopes`, `client_id`, `expires_in`,
`refresh_token`, `code`); `subscriptions` (pre-existing EventSub subscriptions); `page_size`),
`s3.objects` (`"bucket/key": {"text" | "base64", "content_type"}`), `startup` (`compare`, the
default, or `ignore` with a `startup_reason`: calls made before the first step are then left out
of the capture and only counted), `settle_ms` (how long start-up may keep calling before the
first step; default 3000), `compare` (`{"<provider>": "ordered" | "multiset" | "ignore"}` for
every scenario, with a `compare_reason`; a scenario's `compare.calls` wins). Scenario values win
over the target's (same token, user id or object key). Everything written in a `mock` section is
a known input for normalisation.

**Recording and problems.** Every request is recorded: provider, host, method, path, query,
every header (the values of `authorization`, `proxy-authorization`, `x-api-key`, `api-key`,
`cookie`, `x-dimafx-service-token`, `x-amz-security-token`, `x-observability-signature` reduced
to their scheme: `Bearer <redacted>`), the body as received, and what answered it. A request to
a host no provider has, one no route answers, a handler that does not implement it, and anything
the Node preload refused (a socket to a host that is not allowed, a DNS resolution, a proxied
`CONNECT`) are **problems**: answered 501 (or 403 for `CONNECT`) and the scenario fails (`ERROR`)
with every problem shown, even when its steps succeeded.

**Qdrant** is not mocked. With `"qdrant": true` in the target, each side gets a second listener
(`{qdrant_port}`) that forwards to the local Qdrant with the real API key (the side gets a
placeholder) and puts the side's prefix on every collection name in a path
(`rig_<pid>_<n>_<side>__twitch_chat_logs`); the collection list shows only the side's collections,
without the prefix, and the prefix is removed from every answer. Each own-process scenario starts
with no collections; the cleanup path deletes them, and `dima-rig gc` deletes those of rig
processes that are gone. Requests are recorded as provider `qdrant` (not compared).

**How to add a provider or a route.** A host the backend calls that no provider has: add a
provider to `mock/providers.json` (`name`, `hosts`, `about`, and when it applies `compare`,
`headers` to compare, `json_key_order`, `response_headers`, default `routes`), and a row to the
table above. A default route the backend needs in every scenario (realistic for the backend to
run): add it to the provider's `routes`, with `respond` when a canned answer does, or a handler
in `src/mock/handlers.rs` (listed in `HANDLERS` in `src/mock/route.rs`) when the answer needs
state or the request's content. A behaviour only some scenarios need goes in the scenario's
`mock.routes`, never in the defaults. `cargo test -p dima-rig mock::providers` checks the table.

## Outbound call comparison

The calls of each side are compared **per provider**: in the order the provider received them
by default (an extra or missing call is aligned by content and reported once), or as a multiset
where the reference's own order is not deterministic (`posthog` in the table; a scenario's
`compare.calls`, a target's `mock.compare`, or a `set` allowance on `calls.<provider>`), or not
at all (`ignore`: `otlp-logs`, `otel-local`, `qdrant`; `posthog` for the backend targets, whose
batches leave on posthog-node's own 10 s timer, so a scenario that checks analytics sets
`compare.calls.posthog` to `multiset` and waits for the batch with `wait_call`). Multiset calls
pair like documents: equal first, then the most similar, so a changed field is reported where it
is. The mock's answer is not part of the side's behaviour and is not compared.

Each call compares as an object at `calls.<provider>[<i>]`: `method`, `path`, `query` (a
repeated name is an array, in order), `headers` and the body as `body` (JSON, a form or
MessagePack, parsed; gzip undone), `text` (exact) or `bytes`. **Headers compared**:
`authorization`, `x-api-key`, `api-key` (by scheme only: the value never reaches a capture),
`content-type`, `content-encoding`, `accept`, `client-id`, `idempotency-key`,
`x-idempotency-key`, plus each provider's own (OpenRouter's attribution headers, Anthropic's
version and beta headers, S3's `x-amz-acl`, `cache-control` and checksum headers, the internal
API's `traceparent`, `x-observability-signature`, `x-dimafx-service-token`), plus
`compare.call_headers.include`. The user agent and everything else are not compared.
Generated ids and times are normalised as everywhere else (paths and query values included).
**Prompt text compares exactly**, and for providers that cache prompts (`json_key_order`:
OpenRouter, MiniMax) object key order in the request body is a difference, not a note: the
reference keeps its system prompts byte-stable for prompt caching.

## Running the TypeScript backend as the reference

`targets/dimabot-api.json`, `dimabot-bot.json` and `dimabot-cron.json` run the image
`dimabot-ref:0c71108e` (the frozen TypeScript at 0c71108e, built from `dimabot/dockerfile` by the
lead; the rig never builds images) with the production commands (`node dist/server/index.js`,
`node dist/bot/index.js`, `node dist/workers/cron.index.js`) and the production variable names
(`ledger/env.json`) with **test values only** (fixed test secrets in the target files; never the
real ones). Each side has its own MongoDB database and user, its own Dragonfly logical database
(`DRAGONFLY_PORT=6379/<db>`, which the backend's `redis://` + host + `:` + port selects), its own
Qdrant prefix and its own mock. The candidates are `unavailable` until the Rust binaries exist.

**Confinement** (`node/preload.mjs`, loaded with `NODE_OPTIONS=--import=/rig/preload.mjs`; the
source is unchanged): every outbound `fetch` and `http`/`https` request (and `.get`) to a
destination that is not on the side's loopback allow-list (`RIG_DIRECT`: MongoDB, Dragonfly, the
Qdrant proxy, the side's own ports) goes to the mock as `/<host[:port]><path>`; below that every
`net.Socket#connect` (what undici, the MongoDB driver, node-redis and ws use) must go to loopback
and an allowed port, or it is refused; DNS lookups of names that are not loopback are answered
locally with 203.0.113.10 (TEST-NET-3, never routed) and other DNS queries refused, so nothing
reaches a resolver; child processes get `HTTP(S)_PROXY`/`ALL_PROXY` pointing at the mock, which
records them and refuses `CONNECT`; every server listens on 127.0.0.1, and `RIG_LISTEN` maps the
fixed ports (3000, 3333) to the rig's. S3 (`S3_ENDPOINT_URL`, path style) and the sidecars
(`LFM2_EMBEDDINGS_URL`, `PIPER_HTTP_URL`) point at the mock through their variables; the docs
site, the internal API and every provider host are rewritten by the preload.
`tests/confine.rs` proves it with a probe in the same image (fetch, https.get and http.get to
unknown hosts, a raw socket to a public address, DNS resolution, a child `wget`): every attempt
ends at the mock or the guard and the scenario fails listing each one. A program that ignores
both the proxy variables and Node (none in the image does) would not be confined: the container
runs with `--network host`.

**Start-up** (measured on this laptop): the API is ready after about 7 s (it builds the AST
catalog's vectors through the embeddings mock and Qdrant, fetches the docs site, creates its
Qdrant collections and every Mongoose index), about 260 MiB; the bot after about 8 s (ready when
its AST catalog vector index exists: earlier, a chat message is handled seconds late while that
work runs); the cron host's 18 TypeScript worker processes take about 1.5 GiB and
make no outbound call at boot on an empty database. The image has no native Rust binaries, so
`node/cron_index_stub.sh` stands in for `/usr/local/bin/cron_index` (the cron host shuts down
when the native index cannot start; the seven native workers' reference is the Rust in
`dima-rust/src` at 0c71108e). The bot ignores SIGTERM by design (its handler only flushes
metrics), so it is stopped after a 1.5 s grace. Start-up calls are left out of the captures
(`mock.startup: ignore`): they are the same in every scenario.

## Writing a scenario for the backend

1. Seed only what the feature reads: a user document (`accounts[0]` with `type`, `id`, `name`,
   `actived`, `chat_enabled`, `has_permissions`; the account cache is built from it at start-up,
   tokens decrypted with the test `SECRET_KEY`), the feature's documents with explicit BSON
   types and `_id`s. Reusable seeds go in `scenarios/<target>/_seeds/`.
2. Describe the outside world in `mock`: the Twitch users and tokens the feature uses (a user
   token for the auth middleware, a `code` for OAuth), and a route for every call the defaults do
   not answer (the first `record --once` lists them as problems, with the request).
3. Drive it: `http` for the API, `eventsub` for the bot (the subscription type, condition and
   event as Twitch sends them), `polar` for billing webhooks. Effects of an event are mostly
   outbound calls: `wait_call` for the one the feature makes, then `wait_quiet` so the rest has
   landed before the capture.
4. `record <target> <scenario> --once` until it passes, then `record` (two runs) until it is
   stable. Declare what really varies, with a reason: `generated` for random values (AES-CTR IVs
   of stored tokens), `time` with `unit: s` or `min` for epoch numbers, `ttl` for TTL fields,
   `compare.dragonfly.exclude` for logs and telemetry (`logger:*`, `observability:*`,
   `metrics:bot:*`) and start-up caches (`ast_catalog:*`, 660 KB of vectors in every capture
   otherwise). Run `record` once more: it must say `UNCHANGED`.
5. Commit the scenario and its capture together.
