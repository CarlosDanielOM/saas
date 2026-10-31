# Native `create.clip` AST family (handoff, authoring only)

**Nothing in this lane was executed.** No `cargo`, `cargo fmt`, `rustfmt`, `node`,
`npm`, test runner, benchmark, Docker, network call, commit, push or deployment ran.
Every statement below is source reading plus authored code; the build, the tests and
the oracle are **unverified**. Both Rust files and the test are hand-formatted and may
need a `cargo fmt` pass.

Lane: team3, native `create.clip` AST family plus the command/read-back adapters it
needs.

## What this lane adds

| TypeScript source | Native port | Status |
|---|---|---|
| `src/functions/clips/create.clip.ts` (`createClip`) | `functions::clips::create_clip::TwitchFunctions::create_clip` | ported |
| `src/functions/clips/get_clip.clip.ts` (`getClip`) | same module, `TwitchFunctions::get_clip` | ported (transitive dependency of the command) |
| `src/commands/create_clip.command.ts` (`parseClipOptions`) | `create_clip_command::parse_clip_options` | ported |
| `create_clip.command.ts` (`createClipCommand`) | `create_clip_command::TwitchFunctions::create_clip_command` | ported |
| `create_clip.command.ts` (`checkClipStatus`) | `TwitchFunctions::check_clip_status` | ported |
| `src/utils/ast_parser/functions/clip.functions.ts` (`createClipHandler`) | `ast_runtime::functions::BotAstFunctions::create_clip` | ported |
| `registerFunction('create.clip', …, { minUserLevel: 7 })` | `BotAstFunctions::metadata` / `register_into` | ported verbatim |

Files created or edited (nothing else touched):

- `dimabot/src/functions/clips/create.clip.rs` (new)
- `dimabot/src/functions/clips/mod.rs` (new)
- `dimabot/src/commands/create_clip.command.rs` (new)
- `dimabot/src/utils/ast_parser/runtime/functions.rs` (edited: clip seam, adapter, catalog method, dispatch arm, metadata, module doc)
- `dimabot/tests/ast_create_clip.rs` (new)
- `dimabot/tests/fixtures/ast_create_clip_reference.cjs` (new)
- `migration-notes/ast-create-clip-handoff.md` (this file)

## Reuse-first result

Existing sources reused, not duplicated:

- `TwitchFunctions::request_detailed` — one attempt, matching the source's raw `fetch`,
  with the existing token lifecycle instead of a second Helix path.
- `TwitchFunctions::create_clip` / `get_clip` — the only HTTP owners; the AST family and
  the command compose them.
- `utils::links::get_twitch_helix_url` — the canonical URL kept for fidelity and oracle
  comparison; the pooled client applies the endpoint/query to its configured base, so a
  loopback fixture never reaches Twitch.
- `utils::json_number::number_string` — JavaScript `String(number)` for `duration` and for
  numeric clip ids.
- `utils::js_compat::{trim, is_whitespace}` — JavaScript `trim` / `/\s+/` instead of Rust's
  different whitespace set (NEL is excluded in JS, included in Rust; BOM is the reverse).
- `utils::ast_evaluator::to_number` — JavaScript `Number(token)`, so `1e1`, `0x10`,
  `Infinity` and `NaN` behave exactly as in `parseClipOptions`.
- `utils::ast_evaluator::js_string` — `String(arg)` for `parseRawArgument` (not the
  `?? ''` variant).
- `utils::logger::Logger` — the source's `logError(..., { destination: 'both' })` sink.
- `runtime::functions` seams (`AstChatSend`, `AstAnnounceSend`, `AstDelayClock`,
  `BotAstFunctions`) — the clip family is one more seam on the same catalog, not a
  second catalog.

Gaps that remain because they are outside this lane's file list: none of the clip-family
logic is duplicated anywhere; the only missing pieces are the two registrations below.

## Preserved operational behaviour

`createClip` (`POST clips`, `TwitchAuth::Bot`, one attempt):

| Case | Source value |
|---|---|
| bot header missing | `{ error: true, message: "Bot's account does not have the permissions required", status: 403, type: 'permission_error' }`, **not logged** |
| `404` | `{ …, message: 'Broadcaster must be live to create a clip', status: 404, type: 'broadcaster_not_live' }`, body never parsed |
| `202` with `data[0].id` | `{ error: false, message: 'Clip created', status: 202, type: 'success', clipID }` |
| `202` without a usable `data` | `{ …, 'Twitch accepted clip request but did not return a clip ID.', 500, 'clip_id_missing' }` |
| other status | `{ error: true, message: <body.message>, status: <http status>, type: <body.error> }` |
| throw / non-JSON / null root | logged, `{ error: true, message: 'Internal server error', type: 'error' }` (no `status`) |

Query order is `broadcaster_id`, `duration`, `title`. `duration` is appended when it is a
number and not `NaN` (`-3`, `1.5` and `Infinity` are all appended). `title` is appended when
it is truthy **before** trimming and the **trimmed** value goes on the wire, so `"   "`
produces `title=`.

`getClip` (`GET clips?id=`, `TwitchAuth::App`):

- The app-header step runs **before** the empty-id check, as in the source; the native
  empty-id path performs that acquisition and returns `400 clip_id_required` without a
  request.
- The HTTP status is never inspected: the body decides. `data.error` truthy → the body's
  `message` / `status` / `error`; `data.data.length === 0` → `404 clip_not_found`;
  otherwise `{ error: false, message: 'Success', data: data.data[0] }`.
- A null root or a missing `data` throws in the source; natively it is a typed
  `ClipFailure` that becomes the logged `"Internal server error"` value.

`createClipCommand`:

- `parseClipOptions` reproduces `trim` → `split(/\s+/)` → `Number(firstToken)`; a
  non-numeric first token makes the **whole trimmed argument** the title; a numeric one is
  clamped to `5..=60` or `30` and the remaining tokens (joined with one space, trimmed) are
  the title.
- `status === 503` → `Clip creation is currently unavailable.`;
  `status > 500` → `There was an internal Twitch server error that we cannot resolve.`;
  then the `createClip` error, then `Clip ID not returned from creation`, then the lookup.
- `checkClipStatus` polls `getClip`, sleeps **2000 ms** between a `404` and the next poll,
  at most **15** times (16 lookups), then reports
  `There was an error finding the clip, it may have been created but is taking too long to
  process. Please check your clips later.` (status 404). Non-404 errors and successes return
  immediately.
- A lookup success whose `data` is falsy → `There was an unexpected error retrieving the
  clip data.`; otherwise `Clip created successfully: <data.url>` with
  `clipData: data`, `status: 200`, `type: 'Clip created'`.

The 2000 ms pause is a seam (`ClipStatusWaiter`) rather than a removed sleep: it protects
Twitch's clip pipeline from a hot poll loop, and tests prove the retry count without
wall-clock time. Nothing else was shortened or reordered.

`create.clip` AST handler: `args.map(String).join(' ').trim()`, otherwise
`String(ctx.argument || '').trim()`; `parseClipOptions`; `createClip`;
`''` when the result reported an error **or** had no (falsy) `clipID`; otherwise
`https://clips.twitch.tv/<clipID>`. Metadata is `minUserLevel: 7`, `category: 'clip'`,
`syntax: 'create.clip [title]'`, with the source's description, examples and keywords, so the
VM's permission gate behaves like the source's.

## Failure and cancellation shape

- Every source-observable failure is an `Ok` response value, including both `catch` blocks.
  The AST handler therefore stays silent (`''`) for permission refusals, an offline
  broadcaster, an unavailable endpoint and Twitch error bodies — it never invents a URL.
- `Err` exists only for cooperative cancellation: `ClipCancelled` on
  `create_clip_with_cancellation`, `get_clip_with_cancellation` and
  `create_clip_command_with`; `AstRuntimeError::Cancelled` through the AST seam. TypeScript
  has no abort path here. The plain `create_clip_command` wrapper takes no token, so its
  source-shaped response is total.
- A missing clip seam is `AstRuntimeError::Unsupported` naming `create.clip`, `with_clip`
  and `src/functions/clips/create.clip.rs` — never a fabricated empty success.

## Construction and I/O

No constructor performs I/O. `create.clip.rs` builds a request value from strings;
`create_clip.command.rs` only computes options and waits through an injected waiter;
`runtime/functions.rs` stores injected `Arc<dyn …>` seams. The HTTP call happens only when
`create_clip`/`get_clip` is invoked, through the caller's `TwitchFunctions`.

## Test coverage (`dimabot/tests/ast_create_clip.rs`)

Lean (no network, no Twitch, no Docker, no wall-clock sleep):

1. `parseClipOptions`: blank/whitespace/BOM; non-numeric first token makes the whole
   argument the title (interior spacing preserved); `NaN` and NEL-prefixed tokens are titles;
   `30`, `10.5`, `1e1`, `0x10`, `5`, `60`; out-of-range `4`, `61`, `-5`, `Infinity` → 30;
   remaining tokens joined and trimmed; trailing whitespace yields no title.
2. Request shape: broadcaster only; `duration` + `title` order and encoding
   (`title=Epic+win`); `NaN` skipped; `-3`, `1.5`, `1e+21` encoded; empty title skipped,
   whitespace-only title → `title=`, padded title trimmed; canonical URL; `getClip` id query.
3. `createClip` decoding: `202` id; `404` without body parsing; error-body copy with the
   HTTP status (not the body's); missing/empty message; every falsy/empty `data` shape;
   `[{}]`/`[5]`/`"ab"` create-without-id; numeric and null ids; typed `InvalidJson`,
   `NullPropertyAccess("data"|"message"|"id")`, `UndefinedPropertyAccess("id")`.
4. `getClip` decoding: first entry; empty array; error body including body status; falsy
   `error` values; typed `UndefinedPropertyAccess("length")` / `NullPropertyAccess("error")`;
   non-array `data` pass-through.
5. Command response values: every branch's exact JSON (including the `message ||
   'Error creating clip'` fallback and `Clip created successfully: undefined`), plus the four
   constants.
6. AST catalog with a fake seam: URL result; argument joining (`["30","chill"]`, `1e1`,
   out-of-range); `ctx.argument` fallback and the `call`-without-context case; silent
   failures; falsy id; `Cancelled` propagation through both entry points; `Unsupported`
   without the seam; metadata (`category`, `syntax`, level 7, description, examples,
   keywords), six registrations, `register_into`.

Ignored (need an integration execution lease; bind `127.0.0.1`, never Twitch):

7. `loopback_create_and_get_clip_never_contact_twitch`: real client; `POST` path/query/
   headers/empty body; `404`; error body; non-JSON → logged `Internal server error` with the
   source's payload fields; `GET` as the app; empty id with no request; bot-header denial
   with no request and no log.
8. `loopback_create_clip_command_polls_until_the_clip_exists`: 202 → 404 → 404 → 200 with
   two recorded 2000 ms waits; 503; 502; forwarded create error; 202 without an id; 16
   lookups then not-found (15 waits); falsy lookup data.
9. `loopback_ast_create_clip_returns_a_url_or_an_empty_string`: URL, silent failure, and
   the no-argument path over the real catalog.
10. `cancellation_is_typed_and_opens_no_request`: pre-cancelled create/get/command;
    cancellation observed between polls.
11. `oracle_matches_native_clip_family`: replays
    `tests/fixtures/ast_create_clip_reference.cjs` (see below).

## Actual-source oracle

`tests/fixtures/ast_create_clip_reference.cjs` transpiles and executes the real
`create.clip.ts`, `get_clip.clip.ts`, `create_clip.command.ts` and `clip.functions.ts` in a
VM. Only `getTwitchBotHeader`, `getTwitchAppHeader`, `getTwitchHelixUrl`, `logger.error`,
`registerFunction`, `fetch` and `setTimeout` are mocked. It records, per case: the entry
point, the response sequence, the observed request path, the retry pauses, the returned
response JSON and the AST handler's returned string, plus SHA-256 provenance for the four
sources, the four native files, the oracle and the test. Run it as:

```sh
node tests/fixtures/ast_create_clip_reference.cjs --write <empty-dir>
AST_CREATE_CLIP_ORACLE=<empty-dir>/ast_create_clip_cases.json \
  cargo test --features ast-bot-runtime --test ast_create_clip oracle_matches_native_clip_family -- --ignored
```

The fixture pins the toolchain (`node v24.22.1`, `v8 13.6.233.17-node.58`,
`typescript 5.9.3`) and rejects a changed source contract before writing, so a `--check`
mismatch means either the sources or the native port changed.

## Central registrations the integration team must apply

**Not applied by this lane.** These are the only places outside the file list that must change;
until they are in place, `tests/ast_create_clip.rs` compiles to nothing (`#![cfg(feature =
"ast-bot-runtime")]` does not exist yet) and the modules are unreachable.

### 1. `dimabot/src/functions/mod.rs` — mount the clip family

```rust
pub mod clips;
```

`functions::clips::create.clip` uses `utils::js_compat` for JavaScript `trim`. The
`twitch-functions` feature does not currently imply a `js_compat` gate, so a build that
enables **only** `twitch-functions` must add one (`js-unicode17` is the smallest, and
`tts-utilities` is already required by `runtime/chat.rs`). No `ast-bot-runtime` build is
affected, because that feature set must already enable a `js_compat` gate for the existing
`runtime/chat.rs` and `ast_parser/evaluator/value.rs` code. Nothing else in the module needs
a new dependency.

### 2. `dimabot/src/lib.rs` — mount the command port

```rust
#[cfg(feature = "ast-bot-runtime")]
#[path = "commands/create_clip.command.rs"]
pub mod create_clip_command;
```

There is no `src/commands/mod.rs` in the crate yet; a future `commands` module can replace
this `#[path]` declaration with `pub mod commands;` and update the single import in
`runtime/functions.rs` (`use crate::create_clip_command::parse_clip_options;`) accordingly.
The command module needs `utils::js_compat` and `utils::ast_evaluator` (`to_number`), both
already implied by the `ast-bot-runtime` feature proposed in
`migration-notes/ast-bot-runtime-functions.md`.

### 3. Catalog wiring (no code change needed in this lane)

`BotAstFunctions::with_twitch` / `with_twitch_and_logger` now install
`TwitchClipCreateAdapter` automatically, next to the announcement adapter. A caller that
builds the catalog with `BotAstFunctions::new` can add it with
`catalog.with_clip(Arc::new(TwitchClipCreateAdapter::new(twitch.clone())))`. Because
`create.clip` reads `ctx.argument` when the author wrote no arguments, the host that owns the
parser context should call `BotAstFunctions::create_clip(scope, args, Some(argument))`
instead of relying on `call`, which cannot see that field.

## Remaining gaps (not hidden)

1. **`getClip` shares a file.** It lives in `create.clip.rs` because this lane does not own
   `get_clip.clip.rs`; splitting it later only moves two inherent methods (the file comment
   and `clips/mod.rs` say so). A dedicated `get_clip.clip.rs` should carry the same module
   doc when it exists.
2. **Barrel and other clip functions.** `get_clips.clip.ts`, `show_clip.clip.ts` and
   `queue.clip.ts` are not ported; `src/functions/clips/index.ts` has no native counterpart,
   so a native caller must import `functions::clips` directly.
3. **Truthy non-string Twitch fields.** `message` / `error` values that are JSON non-strings
   (`null`, numbers, objects) are treated as absent; the source would copy them through to
   truthiness tests. Twitch returns strings. Non-string `data[0].id` / `data.url` values are
   rendered with `String()` semantics.
4. **One unreachable string-shape difference.** When `data.data` is a JSON **string**, the
   source indexes its first UTF-16 code unit; a supplementary-plane first code unit is a lone
   surrogate that a Rust `String` cannot hold, so the whole first scalar is returned. Twitch
   never returns that shape. The same boundary applies to the AST argument: a lone surrogate
   in `create.clip`'s argument cannot round-trip through `JsString::to_utf8` and becomes a
   typed `AstRuntimeError::Evaluation` instead of an altered title.
5. **Command `catch`.** `createClipCommand`'s `try` cannot throw natively except by
   cancellation, so the plain wrapper projects `Err` onto the source's catch response and logs
   it with the source's fields. The source's ISO `timestamp` and JavaScript `stack` are not
   reproduced (same convention as `runtime/chat.rs` and `announcement.chat.rs`).
6. **Command JSON key order.** `CreateClipCommandResponse::to_json_string` is field-order
   stable but the source's success branch emits `clipData` before `status`; the oracle
   compares parsed objects for that type, and exact strings for `createClip`/`getClip`, whose
   source order is matched byte for byte.
7. **Caller adoption and deployment.** The chat-command path
   (`src/handlers/message.handler.ts` → `indexCommands.createClip`) and the AST registry are
   unchanged; adopting the native command means porting/wiring that caller. Nothing here is
   deployed, and nothing here authorizes a cutover.
8. **Not verified.** No build, test, lint, format or oracle run. Report local feature coverage
   as: the four TypeScript sources above are ported; total migration completion still depends
   on the central registrations in this note.

## Proof paths

- Sources: `dimabot/src/functions/clips/create.clip.ts`,
  `dimabot/src/functions/clips/get_clip.clip.ts`,
  `dimabot/src/commands/create_clip.command.ts`,
  `dimabot/src/utils/ast_parser/functions/clip.functions.ts`,
  `dimabot/src/utils/header.ts` (`getTwitchBotHeader`, `getTwitchAppHeader`),
  `dimabot/src/utils/links.ts`, `dimabot/src/utils/logger.ts`.
- Consumers: `dimabot/src/handlers/message.handler.ts` (`createClip` command),
  `dimabot/src/commands/index.commands.ts`.
- Shared contract: `dimabot/src/utils/ast_parser/runtime.rs`,
  `dimabot/src/utils/ast_parser/runtime/functions.rs`.
- Reused adapters: `dimabot/src/functions/mod.rs` (`TwitchFunctions`,
  `request_detailed`, `query`), `dimabot/src/utils/twitch.rs` (`TwitchAuth`,
  `TwitchClient`, `TwitchEndpoints`), `dimabot/src/utils/js_compat.rs`,
  `dimabot/src/utils/json_number.rs`, `dimabot/src/utils/ast_parser/evaluator/value.rs`
  (`to_number`, `js_string`, `JsString`).
- This lane: `dimabot/src/functions/clips/create.clip.rs`,
  `dimabot/src/functions/clips/mod.rs`, `dimabot/src/commands/create_clip.command.rs`,
  `dimabot/src/utils/ast_parser/runtime/functions.rs`,
  `dimabot/tests/ast_create_clip.rs`,
  `dimabot/tests/fixtures/ast_create_clip_reference.cjs`.
- Neighbouring evidence style: `dimabot/tests/announcement_chat.rs`,
  `dimabot/tests/ast_functions.rs`, `migration-notes/ast-bot-runtime-functions.md`.
