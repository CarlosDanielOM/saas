# Rust migration charter

Approved by the owner on 2026-11-11. This file is the rulebook for everyone working on the migration
(lead, implementation agents, reviewers). Where it differs from the root `CLAUDE.md` / `AGENTS.md`
delivery workflow, this file wins **for migration work**: build and verify, never deploy.

Live status is in [`ledger/`](ledger/): [`ledger/packages.md`](ledger/packages.md) lists every work
package and its state. Read that to see what is done and what is next.

## 1. Goal

Replace all server-side TypeScript/JavaScript with Rust as a **drop-in replacement** for what runs in
production: less memory, less CPU, more throughput, tighter security. Done means: the three `dimabot`
processes and the four small services run from Rust binaries, pass the side-by-side rig against the
reference, and the TypeScript backend source is removed.

**One cutover, all or nothing** (owner's decision, 2026-11-11). Nothing is deployed piece by piece.
When the whole Rust backend is verified here, the images are built on the production server, the
TypeScript containers are stopped and the Rust ones started in one window. Rust never runs beside
TypeScript in production. The goal is performance and safety, not imitation of Node: reproduce what
clients, outside services and existing data depend on, and nothing else.

## 2. Scope

| In (ported to Rust) | Out (stays as is) |
|---|---|
| `dimabot/src` (API server, bot, cron workers, scripts) | Angular sites (`dimasite`, `admin`, `dimadb` UI), Astro docs |
| Existing `dima-rust` workers and library (converted to UTF-8) | Browser code: overlay HTML/JS under `server/routes/public`, `dimafx` client |
| `dimafx/server`, `dima-hoststats`, `dima-analytics`, `dimadb/server` | Python sidecars (`lfm2.5-embeddings`, `piper-tts`), `marketing/`, ops tooling in Python |

External programs the backend shells out to (ffmpeg, ffprobe, yt-dlp, piper) stay external programs.

**Not ported (deprecated by the owner):** the AI `code_execution` tool and its Deno sandbox
(`utils/ai/tools/code_execution.tool.ts`, `utils/ai/sandbox/**`). The Rust AI chat does not offer the
tool, and Deno is not installed in the Rust images. Stored settings and usage records that mention it
stay readable; they simply have no effect.
`origin/rust-migration` (the earlier attempt) is reference reading only. Never merge or copy from it
wholesale: it was built on JavaScript-emulation layers this charter forbids.

**The reference.** Behaviour is defined by what runs in production at baseline commit `0c71108e`:
the TypeScript in `dimabot/src` (frozen for the whole migration), except for the seven cron workers
that are already native (stream activity, raid analytics, follow-defense baseline, roulette completion,
AI usage receipts, raid sessions, dashboard activity). Their reference is the existing Rust in
`dima-rust/src` at that commit; the archived TypeScript for them is history, not the reference.

## 3. Drop-in contract

The contract is what something **outside the Rust backend** depends on. A difference there is a bug
unless section 4 or the decision log allows it.

- **Clients** (the Angular sites, overlays in OBS, the Twitch extension, the desktop app): HTTP paths,
  methods, status codes, response JSON (field names, nesting, value types), the headers they read,
  CORS behaviour, body limits, SSE formats; Socket.IO and WebSocket namespaces, handshake rules, event
  names, payloads and reconnect behaviour. Not contract: the exact text of error pages for malformed
  requests, ETag values, header noise.
- **Outside services**: the same calls to Twitch, OpenRouter, Polar, Resend, S3 and the rest, and the
  same handling of what they send (webhooks, signatures).
- **Existing data in MongoDB**: every existing document must be read correctly, with no data migration.
  New writes keep the same collections, field names, BSON types, defaults, indexes and TTLs, so old and
  new documents look alike. The write helpers in `dima_store::mongo` already do this.
- **Stored identities**: hashes, fingerprints and ids derived from text (Qdrant point ids, hashed
  `_id`s, dedupe fingerprints) keep producing the same value for the same input.
- **Operations**: environment variable names and defaults, ports (3000 API, 3333 EventSub), container
  names, networks, volumes, files on disk.

**Dragonfly is internal.** After the cutover only Rust reads and writes it, so a value's encoding is
Rust's choice: it does not have to match the bytes Node wrote. What matters is the moment of cutover.
Almost all of it is cache that the processes repopulate from MongoDB and Twitch on a clean start (the
`token:<token>` key, for instance, is a validation cache: on a miss the auth middleware validates the
token with Twitch and caches it again, so clearing it logs nobody out). Each key family in
`ledger/dragonfly.md` is one of: *rebuilt* (caches and derived state: cleared at cutover and
recomputed), *drained* (queues of work: emptied by the TypeScript processes before they stop), or
*carried* (work scheduled for later that exists only in Dragonfly, such as delayed command timers and
pending moderator restores, when it cannot be drained: Rust must read what TypeScript left). The
package that ports a key family says which, and only *carried* families need a fixture of the
TypeScript format.

**Rollback.** Going back to TypeScript after the cutover stays possible because MongoDB writes stay
compatible and Dragonfly database 0 was never touched: stop the Rust bot and API, start the TypeScript
ones, let the Rust cron drain, start the TypeScript cron. TypeScript's caches in database 0 are stale by
then and are cleared first so it repopulates them. Nobody is logged out.

**Cutover sequence** (the owner's, 2026-11-11). Stop the TypeScript bot and API and start the Rust bot
and API; let the TypeScript workers finish the work already queued; then stop them and start the Rust
cron. To make the overlap safe without matching formats, Rust uses its own Dragonfly logical database
(the port value `6379/1`, which the address builder already supports) while TypeScript keeps database
0: the TypeScript workers see no new work and simply drain, the Rust bot and API queue their work in
database 1 where it waits for the Rust cron, and neither side reads the other's keys. MongoDB is
shared throughout and stays compatible. Before the TypeScript workers are stopped, the queues that hold
money (AI usage receipts) and work scheduled for later (delayed command timers, pending moderator
restores) must be empty, or be moved across by a small one-off step. Pub/sub channels are server-wide,
so every Rust channel name differs from the TypeScript one. Database 0 is left untouched, which is also
the rollback path.

**Behaviour-preserving port.** Port what the reference does, including odd behaviour users may depend on.
Do not fix bugs silently: record them under "quirks" in the package report. Exceptions: the text rules
in section 4, and security holes (fix, and say so in the report). Every pause, polling interval, batch
size, backoff and lease duration is ported as it is and listed in the package report.

## 4. Text rules (UTF-8)

1. All text is `String` / `&str`. No UTF-16 storage, no `Vec<u16>` text, no JavaScript string emulation.
2. Cuts always land on a character boundary. Byte-index slicing of strings (`&s[a..b]`) is denied by
   lint; use the helpers in the `dima-text` crate or `str::get`.
3. Unpaired surrogate escapes in inbound JSON are replaced with U+FFFD at the edge.
4. What a length, a cut or an ordering must match depends on what it is **for**. Classify every one in
   the code you port:

| Purpose | Rule |
|---|---|
| Our own limit on user text (names, messages, command bodies) and the command language's text functions (`len`, substring, index, padding) | Unicode scalar values (`chars().count()`). Same as JavaScript for ordinary text; an emoji counts 1, so nothing valid today becomes invalid. This is the intended user-visible change. |
| **Money**: a count that feeds credits or cost (for example Fish TTS characters) | Exactly today's number. Where the reference uses `.length`, compute `dima_text::utf16_len`; where it uses `Array.from(x).length`, count scalars. Charges do not change. |
| **Identity**: text that is cut, normalised or sorted before it is hashed, fingerprinted, used as a key, or compared for dedupe | Today's result. Cut with `dima_text::truncate_utf16_budget` (same position as JavaScript, never inside a character); sort the way the reference sorts (ICU collation where it uses `localeCompare`, UTF-16 code-unit order where it uses the default sort); serialise with the canonical JSON writer. |
| A limit that mirrors an outside API's limit (Twitch reward title, announcement text, the chat splitter's 450) | Today's count, cut on a character boundary. Twitch splits chat past 500, so the splitter keeps its 450 budget with an astral character costing 2. |
| A position stored in MongoDB or sent to a client (moderation match start/end, editor error positions, streaming offsets) | The unit the contract already has. Convert at the edge with `dima_text::utf16_offset` and name the contract in a comment, including whether the end is inclusive. |
| Ordering the user sees as a sorted list | ICU collation. |
| Everything else (internal) | Whatever is natural (bytes, scalars, code-point order); never exposed. |

5. A UTF-16 **number** may be computed for the rows above. UTF-16 **data** is never built or stored.
6. JavaScript behaviour that is not about UTF-16 (the `trim` whitespace set, number-to-text formatting
   in chat output, `Number()` coercion in the command language, `Date` to ISO text) is visible behaviour
   and stays. Implement each once in `dima-text` or the command engine, with tests; no scattered copies.
7. List in the package report every length, cut or ordering that is not in the first or last row.

## 5. Layout

```
dima-rust/
  Cargo.toml        workspace root (the pre-existing crate lives here until it is drained into crates/)
  api/              binary: dima-server   (HTTP + Socket.IO, port 3000)
  bot/              binary: dima-bot      (EventSub ingress on 3333 + chat pipeline)
  cron/             binary: dima-cron     (every worker as a supervised task in one process)
  services/         binaries for hoststats, analytics, dimafx-server, dimadb-server
  crates/           shared libraries; the crate map is in ledger/packages.md
  rig/              side-by-side test rig and service mocks
  tools/            cargo wrapper, ledger scripts
  ledger/           inventories and package status
```

Dependencies point one way: text and core types, then the data layer and outside-service clients, then
the command engine and feature crates, then the binaries. Binaries only wire things together. A crate
never depends on a crate above it or on a binary; pure logic does not pull in network or database crates.

`dimabot/` keeps the Compose file, the `.env`, the sidecar Dockerfiles and the feature documents; it
stays the deployment home after its TypeScript source is deleted at the end.

## 6. Engineering rules

- Toolchain pinned in `rust-toolchain.toml`; edition 2024; `#![forbid(unsafe_code)]` in every crate.
- Lints come from the workspace (`[workspace.lints]`): clippy warnings are errors; `unwrap`, `expect`,
  `panic!`, `todo!`, `dbg!` and string byte-slicing are denied outside tests.
- Errors: `thiserror` enums in libraries, `anyhow` only in binaries and tests. Expected failures never panic.
- Async on tokio. No blocking calls on the runtime (`spawn_blocking` for CPU work; child programs through
  the async process API). Every task has an owner and stops on the shutdown token.
- Every network call has a timeout: the reference's value where it has one; where it has none, a generous
  one that only fires on a real hang, listed in the package report.
- Every queue, channel, cache and buffer has a bound. When a bound is hit: telemetry and cache writes are
  dropped and counted; requests are refused the way an overload is today; money, moderation and
  journaled work is never dropped, it waits or fails loudly.
- Configuration is read from the environment **once** at startup into typed structs with the same names,
  defaults and parsing as the reference. No `std::env::var` anywhere else.
- Time and randomness are injected where logic depends on them, so tests are deterministic.
- Dependencies are declared in `[workspace.dependencies]` only. A new external crate needs a line in the
  package report saying why; rustls only (no OpenSSL); `default-features = false` where practical.
- Validate input at the edge with explicit limits. Constant-time comparison for secrets and signatures.
  No secrets or tokens in logs. User-supplied URLs go through the shared SSRF guard.
- Write idiomatic Rust for the intent of the code. Do not transliterate JavaScript mechanics
  (promise chains, `any`-shaped maps, exceptions as control flow).
- No new documents beyond the package report and ledger updates. No "evidence" directories.

**Single-process cron.** Each worker is a supervised task in `dima-cron`. The reference sometimes relies
on killing a process to stop work whose lease is about to expire. The replacement: every unit of work
runs under its deadline; on expiry the task is aborted **and joined** before anything else may take that
work; if it has not stopped within a short grace period the whole process exits non-zero and the
container restarts it. Completion writes are fenced by the lease. A worker that fails or panics is
restarted alone, with backoff. CPU-heavy work and child programs run under explicit concurrency, output
and size limits so one worker cannot starve the others. Blocking Redis commands and subscriptions use
their own connections.

## 7. Data rules

The per-collection and per-key facts are in `ledger/mongo.md` and `ledger/dragonfly.md`. Read the entry
for everything you touch. These rules apply everywhere:

1. **Write only your fields.** Use targeted updates (`$set`, `$inc`, `$push`...) for the fields the
   operation owns, as Mongoose does for a save. Never write back a whole document that was read earlier:
   fields the Rust model does not know must survive.
2. **Missing, null and default are three different states.** Model them and write `null` only where the
   reference writes `null`; queries with `$exists` and sparse unique indexes depend on it.
3. **BSON types are contract**: ObjectId or string ids, Date or epoch-millisecond numbers, int32, int64
   or double, exactly as the ledger records per field. Do not improve them.
4. **The reference for a write is what the reference operation actually stores**, observed in the rig,
   not what the schema file suggests. Mongoose adds and omits things per operation (timestamps, `__v`,
   sub-document `_id`, defaults on upsert). Hooks are part of the write. Every write to a collection
   that has a Mongoose schema goes through the `dima_store::mongo` write helpers, which were derived
   from recordings of Mongoose itself (`crates/store/tests/mongo_golden`); where a recording and the
   prose rules in `ledger/mongo.md` disagree, the recording is right. A field the helpers report as
   dropped (unknown to the schema) is a mistake in the caller: tests fail on it, production logs it.
5. Indexes are created only where the reference creates them, with the same definitions.
6. **A value that is matched by its bytes is carried, not rebuilt.** A queue item acknowledged by
   value (`LREM`), or JSON that a Lua script compares as text, is kept as the bytes that were read
   through claim, completion and requeue; never parse and re-serialise it on the way. Which bytes a
   producer writes is Rust's own choice (see "Dragonfly is internal" in section 3). The JavaScript-exact
   JSON writer (`dima_text::to_js_json`) is required only where the output feeds a stored identity or
   an outside service's signature, and for *carried* key families.
7. Lua scripts are reused verbatim from one shared source file per script. Any new or test script
   must be bounded by an iteration count: Dragonfly has no `SCRIPT KILL` and no Lua time limit, and
   `TIME` is frozen inside a script, so a loop that never ends hangs its shard until the server is
   restarted (this happened to the local server during testing on 2026-11-11).
8. Leases, fences, revisions, status vocabularies and compare-and-set predicates are ported exactly.

## 8. Verification

A package is done when all of these hold:

1. `tools/cargo fmt --check`, `tools/cargo clippy -- -D warnings` and `tools/cargo test` pass for the
   crates it touches (the lead re-runs them, plus the whole workspace, before merging).
2. The reference's test cases for its files are ported as Rust tests (same case names where practical),
   plus cases with emoji, combining marks and right-to-left text wherever it handles text.
3. Externally visible behaviour is covered by rig scenarios once the rig exists (Phase 1).
4. The ledger marks its files and contract items done, and the package report lists deviations,
   quirks, pauses and timeouts, non-default text classifications, and open questions.

**A skipped test is not a passed test.** A test that needs a local store may skip when the store is
absent, so that a plain `cargo test` works anywhere, but `tools/test-env` exports
`DIMA_TEST_REQUIRE_STORES=1`, and with it set such a test must fail when the store, or the data it
expects there, is missing. The lead's gate always runs with it. A read type must decode everything the
write helpers for its collection accept: each collection has a write-then-read test.

**The rig** runs the reference and the Rust candidate on the same inputs and compares responses,
database and cache effects, outbound calls and socket emissions. Allowed differences are listed in its
allow-list with a reason.

- *Real-data mode* uses the local `domdimabot` copy: read endpoints are diffed over real documents, and
  every model must decode every real document of its collection without error (fields already hold a
  mix of int32, int64 and double, legacy fields and missing fields).
- *Synthetic mode*: each implementation gets its own fresh database and cache, seeded identically from
  fixtures, runs the scenario, and the whole database and key space are compared afterwards: typed BSON,
  missing versus null, TTLs and deadlines relative to the scenario clock, generated ids mapped consistently.
- Scenarios are classified by what they really write, not by HTTP method. Workers that scan everything
  run in synthetic mode only.
- Every outside service is a local, stateful mock (pagination, retries, injected failures). Rig
  processes have no route to the internet, and a request the mock does not expect fails the scenario.
- Money, authentication, moderation and data-integrity packages add fault scenarios: duplicate delivery,
  restart in the middle of an operation, timeout after commit, lost lease, and two Rust processes racing
  on the same data (the bot, the API and the cron share it).
- What the rig compares follows section 3: responses and MongoDB state are compared with the reference;
  Dragonfly state is compared by meaning (which keys exist, their parsed content and TTLs), not by
  bytes, and only for *carried* families is the reference's format itself checked.

Rigour by risk: money (billing, credits), authentication and tokens, moderation actions, and data
integrity (journals, queues, account deletion) get the highest effort and always a second review.

## 9. How the work runs

- **Lead (Claude Fable)** cuts packages, fixes the interfaces between crates, writes briefs, integrates,
  runs the gates and commits. Nothing merges on a worker's report alone.
- **Implementation (Claude Opus 5.5, high or xhigh)**: one package per agent, one crate or module
  directory owned exclusively, in its own git worktree. Stay inside the files the brief assigns.
- **Where the branch lives.** The lead integrates in its own checkout of `rust-v2`
  (`~/Projects/saas-rust-v2`), not in the main checkout, which may be on another branch at any time.
  A worker's new worktree can therefore start from an old commit: the first step of every package is
  `git merge --ff-only rust-v2`, checked against the commit the brief names. `dimabot/node_modules`
  (for recording against the real libraries) is used from the main checkout, read-only.
- **Review (GPT-6.1 Sol, high or xhigh)**: a teammate, not an authority. The lead verifies findings and
  decides; low-value findings are set aside and noted.
- Agents do not deploy, do not start subagents, do not touch `dimabot/` or another package's files, and
  do not start the Python sidecars. Outside services are always mocked; no real third-party calls.
- The local MongoDB database `domdimabot` is a stale production copy and is the shared playground:
  use it directly, do not copy it. Use ids in a range the brief assigns for anything a test creates, and
  clean up after a test. Do not paste raw tokens into reports.
- Commits: conventional type, then `Agent:` line naming the models and harness, per the root commit policy.

## 10. Phases

| # | Phase | Ends when |
|---|---|---|
| 0 | Charter and ledger | Inventories written, packages cut, second view from the reviewer taken |
| 1 | Foundation: workspace, text, config, logging, data layer, clients, rig, one small service as pilot | Pilot passes the rig end to end |
| 2 | Existing Rust converted to UTF-8 and moved into the workspace | Existing tests pass; only emoji/surrogate expectations changed; moved code passes integration checks |
| 3 | Shared crates and the cron binary: all workers in one `dima-cron`; command engine complete. Starts with three thin end-to-end slices (timer to engine to chat delivery; journal to consumer to effect; usage to receipt to dashboard) before the rest fans out | Rig green |
| 4 | Bot | Rig green |
| 5 | API | Rig green |
| 6 | Remaining small services | Each rig green |
| 7 | Whole-system check: the three Rust binaries and the small services running together here against the local stores and the mocks, driven end to end; images; the cutover and rollback procedure written and rehearsed; resource report | Owner's go for the cutover |
| 8 | After the cutover holds in production: TypeScript backend source removed, docs updated | Done |

Phases 3 to 6 are a build order, not a release order: nothing ships until phase 7 ends. The cutover
itself happens on the production server (images built there through `scripts/saas-ops`), all processes
in one window, and is the owner's to trigger.

## 11. Machine limits (development laptop)

- **Always** run cargo through `dima-rust/tools/cargo` (same arguments as cargo). It puts every build in
  one cgroup with a 6 GB soft cap, an 8 GB hard cap, 8 CPUs and no swap, gives each run an equal share
  sized to the memory that is actually free (and waits when there is too little), and lets two builds or
  test runs go at a time across the machine. Each checkout builds into its own `dima-rust/target`: a
  shared target directory let one worktree's tests run against another worktree's code, so never set
  `CARGO_TARGET_DIR` to a shared place. A new checkout's first build starts from a copy-on-write copy of
  the lead's snapshot of the build cache, so only the workspace crates compile. Never run plain `cargo`.
  Start long-lived programs from the built binary, not `cargo run`.
- Implementation agents run `check`, `clippy` and `test` scoped to their crates (`-p <crate>`). Release
  builds and whole-workspace runs are the lead's.
- The laptop has 16 GB in total and is the owner's working machine: it must never run out of memory.
  Do not start extra database containers; MongoDB, Dragonfly, Qdrant and Postgres are already running
  on loopback without authentication needs for tests. Do not run the embeddings or Piper containers.
  Anything else that is memory-hungry (a Node build, a test container) is started only by the lead.

## 12. Decision log

- 2026-11-11: Scope, staged cutover order, TypeScript freeze, text rules, layout approved by the owner.
- 2026-11-11: Chat splitter keeps the 450 budget with today's counting (astral characters cost 2).
- 2026-11-11: Local `domdimabot` database is used directly as test data; no copy is made.
- 2026-11-11: Build memory is a 6 GB soft cap and an 8 GB hard cap; the laptop must not run out of memory.
- 2026-11-11: The production `SECRET_KEY` is not available here. Token encryption is verified by
  TypeScript and Rust encrypting and decrypting each other's output with a test key, not by decrypting
  stored tokens. Local Dragonfly and Qdrant are used without authentication; production auth stays in production.
- 2026-11-11: The owner declared AI code execution (Deno sandbox) deprecated: it is not ported.
- 2026-11-11: `Date.parse` is reproduced for ISO 8601 and HTTP date forms only. Text that only V8's
  lenient legacy parser accepts (for example `2026-11-11 15:04:05` or `11/11/2026`) is rejected. No
  Twitch, Polar or stored format needs it; a client that sent such a cursor to the stream timeline
  route would now get the invalid-date answer. Allowed difference.
- 2026-11-11: Stricter than Node on malformed input, on purpose (allowed differences): hex and base64
  text containing non-ASCII characters is rejected (Node decodes it using the low byte of each UTF-16
  unit); a JSON number beyond the double range (`1e400`) is a parse error in request bodies, JWT claims
  and environment JSON (JavaScript reads `Infinity`); a PEM public key is never accepted as an HMAC
  secret because no asymmetric keys exist in this system.
- 2026-11-11: `parseInt` is offered for no radix, 2, 8, 10 and 16 only (the reference uses none, 10
  and 8); other radices are implementation-dependent above 2^53 by specification.
- 2026-11-11 (later the same day, supersedes "staged cutover" above and the mixed-runtime parts of the
  entry below): **one cutover, all or nothing.** The owner does not want Node imitated beyond what
  clients, outside services and existing data need, and will switch every process at once. Rust never
  runs beside TypeScript in production, so Dragonfly encodings are Rust's own (key families are drained,
  rebuilt or carried at cutover), byte-for-byte agreement with node-redis writers is no longer required,
  and reviews stop looking for TypeScript/Rust interleavings. MongoDB writes stay compatible (the helpers
  exist and it keeps rollback possible). Dragonfly is a cache that repopulates on a clean start, as the
  owner pointed out; a clear costs only what is queued at that moment.
- 2026-11-11: After the reviewer's second view (GPT-6.1 Sol): the compatibility rule now also covers the
  rollback release; the reference is named per responsibility; text rules gained the purpose table so
  that money counts, identity inputs, mirrored outside limits and stored positions keep today's values;
  data rules 1 to 8 added; single-process cron semantics defined; the rig gained real-data and synthetic
  modes and fault scenarios; Phase 3 starts with end-to-end slices. Set aside: comparing full causal
  histories for every package (kept for the high-risk ones only).
