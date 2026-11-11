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

These may not change. A difference here is a bug unless section 4 or the decision log allows it.

- **HTTP**: paths, methods, status codes, response JSON (field names, nesting, value types), headers
  clients rely on, CORS behaviour, body limits, SSE formats.
- **Socket.IO and WebSocket**: namespaces, handshake rules, event names, payloads, rooms, reconnect behaviour.
- **MongoDB**: collection names, field names and BSON types, defaults, indexes, TTLs. No data migration.
- **Dragonfly**: key names, value encodings, TTLs, streams, queues, pub/sub channels, Lua scripts.
- **Outside services**: the same calls to Twitch, OpenRouter, Polar, Resend, S3 and the rest.
- **Operations**: environment variable names and defaults, ports (3000 API, 3333 EventSub), container
  names, networks, volumes, files on disk.

**Compatibility rule.** Roles are switched one at a time (cron, then bot, then API). A Rust process
must interoperate with every process that can run beside it **and** with the release it would be
rolled back to: it writes only data those readers handle, in MongoDB and Dragonfly, and it handles
everything they write. This holds until the lead closes the rollback window for that role in the
decision log, which happens only once the TypeScript for that role is retired. Switching a role
includes its handoff: queues drained or safely shared, leases expired or honoured, one owner per job.

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
   sub-document `_id`, defaults on upsert). Hooks are part of the write.
5. Indexes are created only where the reference creates them, with the same definitions.
6. **Byte-compared values are opaque.** A queue item removed by value, JSON compared inside Lua, or a
   payload that was hashed is carried as the bytes received through claim, completion and requeue; never
   parse and re-serialise it. A value Rust creates that TypeScript or Lua will compare byte-wise is
   written with the shared canonical JSON writer (`dima_text::to_js_json`), from a value shaped as the
   TypeScript producer's object looks after JavaScript's own conversion: absent properties omitted (not
   `null`), keys in the producer's order, dates as the producer serialises them. Each such producer gets
   a fixture recorded from the reference in the package that ports it.
7. Lua scripts are reused verbatim from one shared source file per script.
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
  restart in the middle of an operation, timeout after commit, lost lease, and a TypeScript writer racing
  a Rust writer on the same data.

Rigour by risk: money (billing, credits), authentication and tokens, moderation actions, and data
integrity (journals, queues, account deletion) get the highest effort and always a second review.

## 9. How the work runs

- **Lead (Claude Fable)** cuts packages, fixes the interfaces between crates, writes briefs, integrates,
  runs the gates and commits. Nothing merges on a worker's report alone.
- **Implementation (Claude Opus 5.5, high or xhigh)**: one package per agent, one crate or module
  directory owned exclusively, in its own git worktree. Stay inside the files the brief assigns.
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
| 3 | Cron: all workers in one `dima-cron` binary; shared command engine complete. Starts with three thin end-to-end slices (timer to engine to chat delivery; journal to consumer to effect; usage to receipt to dashboard) before the rest fans out | Rig green; release-ready |
| 4 | Bot | Rig green; release-ready |
| 5 | API | Rig green; release-ready |
| 6 | Remaining small services | Each rig green |
| 7 | TypeScript backend removed, images slimmed, docs updated, resource report | Done |

Deployment happens on the production server through `scripts/saas-ops`, one process at a time, and is
not part of any package.

## 11. Machine limits (development laptop)

- **Always** run cargo through `dima-rust/tools/cargo` (same arguments as cargo). It puts every build in
  one cgroup with a 6 GB soft cap, an 8 GB hard cap, 8 CPUs and no swap, sizes each run to the memory
  that is actually free (and waits when there is too little), and uses one shared target directory so
  worktrees reuse compiled dependencies. Never run plain `cargo`. Never run `cargo clean`.
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
- 2026-11-11: `parseInt` is offered for no radix, 2, 8, 10 and 16 only (the reference uses none, 10
  and 8); other radices are implementation-dependent above 2^53 by specification.
- 2026-11-11: After the reviewer's second view (GPT-6.1 Sol): the compatibility rule now also covers the
  rollback release; the reference is named per responsibility; text rules gained the purpose table so
  that money counts, identity inputs, mirrored outside limits and stored positions keep today's values;
  data rules 1 to 8 added; single-process cron semantics defined; the rig gained real-data and synthetic
  modes and fault scenarios; Phase 3 starts with end-to-end slices. Set aside: comparing full causal
  histories for every package (kept for the high-risk ones only).
