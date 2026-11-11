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
TypeScript version, and the TypeScript backend source is removed.

## 2. Scope

| In (ported to Rust) | Out (stays as is) |
|---|---|
| `dimabot/src` (API server, bot, cron workers, scripts) | Angular sites (`dimasite`, `admin`, `dimadb` UI), Astro docs |
| Existing `dima-rust` workers and library (converted to UTF-8) | Browser code: overlay HTML/JS under `server/routes/public`, `dimafx` client |
| `dimafx/server`, `dima-hoststats`, `dima-analytics`, `dimadb/server` | Python sidecars (`lfm2.5-embeddings`, `piper-tts`), `marketing/`, ops tooling in Python |

External programs the backend shells out to (ffmpeg, yt-dlp, deno) stay external programs.
TypeScript is frozen for the whole migration; `dimabot/` is the reference implementation and the
rollback target. `origin/rust-migration` (the earlier attempt) is reference reading only. Never merge
or copy from it wholesale: it was built on JavaScript-emulation layers this charter forbids.

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

**Rollback rule.** Until the TypeScript process for a role is retired, the Rust process writes only
data the TypeScript code can read, in MongoDB and in Dragonfly. Processes are switched one at a time
(cron, then bot, then API), so a Rust process must interoperate with TypeScript processes.

**Behaviour-preserving port.** Port what the code does, including odd behaviour users may depend on.
Do not fix bugs silently: record them under "quirks" in the package report. Exceptions: the text rules
in section 4, and security holes (fix, and say so in the report).

## 4. Text rules (UTF-8)

1. All text is `String` / `&str`. No UTF-16 storage, no `Vec<u16>` text, no JavaScript string emulation.
2. **Length** of user-facing text means Unicode scalar values (`chars().count()`). It equals the
   JavaScript count for ordinary text and is smaller for emoji, so nothing valid today becomes invalid.
3. **Slicing and truncation** happen on character boundaries. Byte-index slicing of strings
   (`&s[a..b]`) is denied by lint; use the helpers in the `dima-text` crate or `str::get`.
4. Command-language functions that count or cut text (`len`, substring, index, padding) follow rules 2 and 3.
   This is the one intended user-visible change (an emoji counts as 1, never gets cut in half).
5. A UTF-16 **number** (never UTF-16 data) is computed only at an edge whose contract is defined that way:
   a position sent to a JavaScript client that indexes its own string, and the chat splitter's
   450 budget, which keeps today's counting (an astral character costs 2) because Twitch splits past 500.
   Use `dima_text::utf16_len` / `utf16_offset` and name the contract in a comment.
6. Unpaired surrogate escapes in inbound JSON are replaced with U+FFFD at the edge.
7. Ordering is code-point order unless the user sees a locale-sorted list; then use ICU collation.
8. Things that are JavaScript behaviour but **not** UTF-16 (the `trim` whitespace set, number-to-text
   formatting in chat output, `Number()` coercion in the command language) are visible behaviour and
   stay. Implement each once in `dima-text` or the command engine, with tests; do not scatter copies.

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

`dimabot/` keeps the Compose file, the `.env`, the sidecar Dockerfiles and the feature documents; it
stays the deployment home after its TypeScript source is deleted at the end.

## 6. Engineering rules

- Toolchain pinned in `rust-toolchain.toml`; edition 2024; `#![forbid(unsafe_code)]` in every crate.
- Lints come from the workspace (`[workspace.lints]`): clippy warnings are errors; `unwrap`, `expect`,
  `panic!`, `todo!`, `dbg!` and string byte-slicing are denied outside tests.
- Errors: `thiserror` enums in libraries, `anyhow` only in binaries and tests. Expected failures never panic.
- Async on tokio. No blocking calls on the runtime (`spawn_blocking` for CPU work and child processes
  that block). Every task has an owner and stops on the shutdown token.
- Every network call has a timeout. Every queue, channel, cache and buffer has a bound.
- Configuration is read from the environment **once** at startup into typed structs with the same names
  and defaults as the TypeScript. No `std::env::var` anywhere else.
- Time and randomness are injected where logic depends on them, so tests are deterministic.
- Dependencies are declared in `[workspace.dependencies]` only. A new external crate needs a line in the
  package report saying why; rustls only (no OpenSSL); `default-features = false` where practical.
- Validate input at the edge with explicit limits. Constant-time comparison for secrets and signatures.
  No secrets or tokens in logs. User-supplied URLs go through the shared SSRF guard.
- Write idiomatic Rust for the intent of the code. Do not transliterate JavaScript mechanics
  (promise chains, `any`-shaped maps, exceptions as control flow).
- No new documents beyond the package report and ledger updates. No "evidence" directories.

## 7. Data rules

Filled in from `ledger/mongo.md` and `ledger/dragonfly.md` when the data layer lands (Phase 1). Until
then: read the ledger entry for every collection and key you touch and match it exactly.

## 8. Verification

A package is done when all of these hold:

1. `tools/cargo fmt --check`, `tools/cargo clippy -- -D warnings` and `tools/cargo test` pass for the
   crates it touches (the lead re-runs them, plus the whole workspace, before merging).
2. The TypeScript test cases for its files are ported as Rust tests (same case names where practical),
   plus cases with emoji, combining marks and right-to-left text wherever it handles text.
3. Externally visible behaviour is covered by rig scenarios once the rig exists (Phase 1): the same
   requests and events go to the TypeScript process and the Rust process, and responses, database and
   cache effects, outbound calls and socket emissions are compared. Allowed differences are listed in
   the rig's allow-list with a reason.
4. The ledger marks its files and contract items done, and the package report lists deviations,
   quirks and open questions.

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
| 2 | Existing Rust converted to UTF-8 and moved into the workspace | Existing tests pass; only emoji/surrogate expectations changed |
| 3 | Cron: all workers in one `dima-cron` binary; shared command engine complete | Rig green; release-ready |
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
