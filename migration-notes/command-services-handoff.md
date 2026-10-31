# Command defaults + command blocks service — authoring handoff

Slice `team2-slice-5-command-services` of `team2-api-data`.
Workspace: `/root/saas-rust` (shared checkout). Authoring only: no Cargo,
rustfmt, Node, tests, Docker, installs or deployment were run, and nothing was
committed. Every statement below is a source/static reading result, not an
execution result.

## 1. Scope and source mapping

| Source (TypeScript) | Native (this slice) |
|---|---|
| `dimabot/src/server/services/command_defaults.service.ts` | `dimabot/src/server/services/command_defaults.service.rs` |
| `dimabot/src/server/services/command_blocks.service.ts` | `dimabot/src/server/services/command_blocks.service.rs` |
| `dimabot/src/server/services/command_defaults.service.test.ts` | oracle expectations in `dimabot/tests/fixtures/command_services_reference.cjs` + `dimabot/tests/command_services.rs` |

Owned paths only: the two service files, `tests/command_services.rs`,
`tests/support/command_services_support.rs`,
`tests/fixtures/command_services_reference.cjs`, and this note. Central files
(`Cargo.toml`, `src/lib.rs`, `src/utils/mod.rs`, `src/schemas/mod.rs`,
`src/schemas/schema.rs`) were not touched; the required snippets are in §9.

## 2. Reuse (nothing re-ported)

* **Command cooldown** — `crate::utils::command_cooldown`:
  `write_command_with_cooldown`, `CooldownStore`, `CooldownError`,
  `minimum_command_cooldown`. Team 3's `command_cooldown_write.ts` remains
  unmigrated only as a source reference and was **not** ported.
* **Account directory** — `crate::utils::twitch_streamers::TwitchStreamers`.
  `CommandDefaultsStore::owner_plan` calls the existing concrete
  `account_by_id`, so the plan read uses the application's real plan cache,
  fence and generation rules instead of a parallel `users` query.
* **AST blocks** — `crate::utils::ast_blocks::{compile_blocks, stored_blocks,
  BlocksError, MAX_COMMAND_TEXT}` (`MAX_COMMAND_TEXT = 10_000`,
  `types.rs:8`, re-exported by `index.rs:30`).
* **Schemas** — `crate::schemas::commands` (`schema`, `collection`,
  `prepare_insert`). `crate::schemas::users` is used only by the disposable
  fixtures to seed the document the directory hydrates.
* **Catalog** — the existing `dimabot/src/config/commands/reservedcommands.json`,
  embedded with `include_str!("../../config/commands/reservedcommands.json")`
  and parsed once into a `LazyLock<serde_json::Value>`; 38 entries, none edited.
* **JavaScript semantics** — `crate::utils::js_compat::trim` (the source's
  `trim()`), `crate::utils::bson_compat::js_number` (the Node BSON number rule),
  `String::encode_utf16().count()` for `String.prototype.length`.

`command-services` therefore needs `twitch-streamers` (which pulls
`twitch-client`, `logger`, `plan-cache`) in its feature closure; see §9.

## 3. Behavior traced against the source

### `command_defaults.service.ts`

| Source behavior | Native |
|---|---|
| `getDefaultCommandID` = `sha256(JSON.stringify([namespace, channelID, func]))` truncated to 24 lowercase hex | `default_command_id` (`sha2`, `serde_json::to_string`, `ObjectId::parse_str`) |
| `normalizeSupportedLanguage` = `String(lang \|\| '').trim().toLowerCase() === 'es'` | `normalize_supported_language` |
| `getReservedCommandDefinition`: `func` match first (only when truthy), then `cmd` (only when truthy), first entry wins | `get_reserved_command_definition` |
| `getLocalizedReservedCommandDescription`: string description used verbatim; object prefers the normalized language, then `en`, then the fallback; empty strings fall through | `get_localized_reserved_command_description` |
| `getReservedCommandsPayload`: no language → the raw entries (extra keys preserved); a language → shallow copy with the localized `description` | `get_reserved_commands_payload` (returns a clone, so callers cannot mutate the embedded catalog) |
| `ensureReservedCommands`: per entry `exists({func, activation:{$ne:'keyword'}, channelID})`, skip when present | same filter/collection probe |
| draft: `_id`, `name`, `cmd`, `func`, `type`, `channel`, `channelID`, `cooldown`, `enabled`, `userLevel \|\| 0`, `userLevelName \|\| 'everyone'`, `reserved`, `message \|\| ''`, `responses: []`, `paused: false`, `platform: 'twitch'`, `premiumRequired: false`, `premiumLevelRequired: 0`, `createdAt: new Date()` | `default_command_draft`; absent source fields stay absent so `prepare_insert` applies the same Mongoose defaults (`activation`, `authoring`, `blocks`, `variables`, `description`, `count`, `permissionExpression`, `permissions`, `date.*`, `__v`) |
| owner plan via `TwitchStreamers.getTwitchAccountById(channelID)?.plan_tier`; the class catches **every** failure, logs it and returns `null` (`classes/twitch_streamers.class.ts:162-178`) | `owner_plan` = `account_by_id(...).ok().map(plan_tier)`; every `DirectoryError` (missing, stale, fence, store/cache unavailable, deadline) degrades to free-tier policy exactly like the source's `null` |
| `!reserved && cooldown === 0` → `writeCommandWithCooldown(channelID, 0, null, save)` | `write_command_with_cooldown(store, channel, Some(0), None, insert)` |
| `CommandCooldownError` → `cooldown = 5` and a plain save | `CooldownError::Invalid` → retry document with `cooldown: 5`, plain insert |
| duplicate key `11000` → `exists({_id, func, channelID})`; absent → rethrow, present → swallow without counting | same, via the public `is_duplicate_key_error` classifier |
| `createdCount` counts successful inserts only | same |

The only catalog entry that enters the zero-slot branch is `speach`
(`reserved: false`, `cooldown: 0`); `vanish` has `cooldown: 0` but is reserved.
The pinned test asserts this invariant.

### `command_blocks.service.ts`

| Source behavior | Native |
|---|---|
| `channelPlanTier`: `findOne({accounts:{$elemMatch:{type:'twitch',id}}}).select('plan_tier').maxTimeMS(1500).lean()`, `pro`/`premium`/else `free` | `CommandBlocksService::channel_plan_tier` with the same projection and `max_time(1500ms)` |
| `canEditBlocks` = premium or pro | `can_edit_blocks` |
| `presentCommand`: authoring forced to `'blocks'`/`'text'`, block commands get `message: ''`, `blocks` deleted unless the command is a block command **and** `options.blocks` | `present_command` (same key deletions; non-object input behaves like the JS spread of a non-object) |
| `resolveCommandBody` ordering: settings-only return → reserved `400` → plan `403` → compile `400 blocks_invalid` | identical ordering, including that the settings-only body and the reserved rejection happen **before** the plan read |
| text branch: `'message' in body` check, non-string coerced to `''`, `message.length > MAX_COMMAND_TEXT` (UTF-16), blank reply from a block command → `400 missing_message`, `{authoring:'text',blocks:null,message}` only when the command was or is a text command | `resolve_command_body_with_plan` |
| error envelopes `{status, code, message, blockId?}` | `CommandBlocksRequestError` with accessors |

`resolve_command_body` is the source function (settings-only guard + the one
plan read). `resolve_command_body_with_plan` is its post-await tail, exposed so
the body rules can be compared without a database while the production method
still uses the real owner read.

## 4. Concrete adapters (no trait-only completion)

`CommandDefaultsStore` implements `CooldownStore` with real dependencies:

* `owner_plan` — the application `Arc<TwitchStreamers>` (`account_by_id`), i.e.
  the same cache/fence-aware directory the rest of the backend uses.
* `acquire_lease` — Redis `SET key token NX EX 60`.
* `editable_zero_exists` — `commands.find_one({channelID, cooldown: 0,
  reserved: {$ne: true}})` (+ `_id: {$ne: …}` when a current id is supplied).
* `release_lease` — the shared `RELEASE_LEASE_SCRIPT` compare-and-delete.
* `new(database, directory)` uses the process lazy Dragonfly client only when
  the lease is needed; `with_redis(database, directory, connection)` injects a
  pooled one.

`CommandBlocksService` holds the real `users` collection and performs the only
read the source performs.

## 5. Adapter differences (deliberate, recorded)

1. **Owner-plan logging.** The source class logs a swallowed directory failure
   (`error({function:'TwitchStreamers.getTwitchAccountById', ...})`). The native
   directory logs only identity failures, so a swallowed plan read is silent
   here. The plan value and the null-degradation are identical.
2. **Clock.** `DateTime::now()` replaces `new Date()`; BSON keeps millisecond
   precision. `ensure_reserved_commands_at` accepts a fixed instant so the
   oracle replay is deterministic; production uses a per-command clock.
3. **Catalog immutability.** The TypeScript payload returns the shared module
   array; the native payload is a clone.
4. **Error type.** `CommandBlocksService::resolve_command_body` returns
   `CommandBlocksError` (`Request`, `Mongo`, `Serialize`) so the future route
   can answer the source envelope for `Request` and its 500 path otherwise.
   The source has no such enum; the route is not part of this slice.
5. **`userLevelName`/`message` falsy rules** use `filter(!is_empty)` rather than
   JS truthiness because the embedded catalog only contains strings; a numeric
   or boolean `message` would be coerced to `''` by the source and is not
   representable in the frozen JSON.
6. **Persisted-document parity (checked, no divergence).** Mongoose's insert
   path (`Model.prototype.$__handleSave`, `node_modules/mongoose/lib/model.js:360-374`)
   sends `this.toObject(saveToObjectOptions)` to `collection.insertOne`, where
   `saveToObjectOptions` comes from `internalToObjectOptions` and therefore
   keeps the schema's default `minimize: true`. Empty POJO defaults
   (`permissions: {}`) are removed before the insert, `__v` is added by
   `$__version(true, obj)`, and Map defaults (`variables: {}`) survive. That is
   exactly what the native `prepare_insert` writes, so the earlier
   "non-minimized `toObject`" concern is withdrawn and no schema change is
   needed. The oracle now records the intercepted insert payload (§6) and the
   replay compares it byte for byte.

## 6. Source oracle (`tests/fixtures/command_services_reference.cjs`)

Written for the pinned isolated toolchain (Node 24.22.1, TypeScript 5.9.3,
Mongoose 8.24.2, BSON 6.10.4; `TZ=UTC` set and asserted). It transpiles and runs
the **real** `command_defaults.service.ts`, `command_blocks.service.ts` and
`command_cooldown_write.ts` with the real Commands and availability schemas on a
disconnected Mongoose instance.

Persistence is the real Mongoose save pipeline: the fixture replaces only
`Commands.collection.insertOne` with a recorder, so defaults, casting,
validation, `__v` versioning and error handling are Mongoose's. The recorded
`docsHex` is the exact object handed to `collection.insertOne`, i.e. the
minimized `toObject` payload plus `__v` that reaches MongoDB. `TwitchStreamers`
and `getDragonflyClient` are in-memory doubles; the lease Redis is in memory.

Recorded boundaries (also stored in the fixture's `boundaries` field):

* `src/utils/ast_blocks/` is retired; `compileBlocks`/`storedBlocks`/
  `MAX_COMMAND_TEXT`/`BlocksError` are stand-ins. The two error messages used
  and the literal echo compile match the native compiler, but **block
  compilation itself is not compared here** — that belongs to the AST parity
  suites.
* `src/utils/command_cooldown.ts` is retired; the one-symbol
  `getMinimumCommandCooldown` policy is supplied verbatim.
* The JSON import assertion is stripped before the CommonJS emit; the pinned
  digest is of the original file.
* The source-side plan double models the class contract (`{plan_tier}` or
  `null`), not the cache/fence mechanics; those are exercised natively (§7).

Case inventory: 22 `defaults-pure`, 9 `defaults-seed`, 5 `blocks-plan`,
5 `blocks-pure`, 14 `blocks-resolve` = **55**, all native-replayable. The two
write-error cases compare the error **class** (duplicate vs non-duplicate), not
the driver message: a real MongoDB cannot reproduce the fixture's injected
message, but it can reproduce the branch with a unique index and a collection
validator. Coverage that counts is cases actually replayed: **0 executed in
this authoring wave**.

## 7. Private adapter checks (`tests/command_services.rs`)

Un-gated `#[test]` (no service or environment):

* embedded catalog = the source file; 38 unique functions; exactly one
  zero-slot command (`speach`); localized payload keeps extra keys; empty
  language is the raw payload.
* definition lookup precedence and `trim`/case language normalization.
* default IDs are deterministic, channel-scoped 24-hex `ObjectId`s computed from
  the documented digest.
* `presentCommand` hides blocks and blank-compiled messages.
* resolver text rules (switch, missing/blank message, plain text, message-only,
  settings-only) and the UTF-16 limit (10 000 accepted, 10 001 rejected, 5 001
  astral characters = 10 002 units).
* resolver block rules: reserved before plan, free plan rejected, canonical
  literal tree compiles with `{v:1, root}` and the source text, missing tree is
  `400 blocks_invalid`.

`#[ignore]` oracle replays:

* `the_oracle_pins_the_expected_cases` — full 55-name list, constants
  (namespace, catalog size, `MAX_COMMAND_TEXT`, duplicate code).
* `replays_the_pure_source_cases` — the 22 `defaults-pure` and 5 `blocks-pure`
  cases.
* `replays_the_recorded_seed_cases` — one fresh database per case against the
  real MongoDB, Redis and account directory. Fresh channel (all 38 persisted
  documents compared field-for-field, including `_id`/`Date`/numbers/`__v` and
  the absence of an empty `permissions` default), a `pro` account, a missing
  account, an existing custom command, the zero-slot conflict (fallback
  `cooldown: 5`), a held lease (contention fallback, the incumbent lease
  survives), the concurrent double-seed (sum, document count, no duplicate
  functions, this caller's lease released), and the two write-error branches:
  * duplicate without a matching row — a `keyword`-activation collider makes the
    existence probe skip, a unique `func` index raises `11000`, and the
    `{_id, func, channelID}` re-check finds nothing, so the error is rethrown;
  * non-duplicate failure — a collection validator rejects the insert with a
    non-`11000` error, which is rethrown and stores nothing.
* `replays_the_recorded_plan_and_body_cases` — 5 plan cases and 14 resolver
  cases against seeded `users` documents, comparing status/code/message/blockId
  or the exact payload.

Directory suites (real `TwitchStreamers` over the disposable MongoDB/Redis, a
fixture credentials adapter and a metadata-store failure double; no cache
double):

* `plan_read_uses_the_cached_account_directory` — hydrate from `users`, then
  delete the authoritative document and still get `pro` from the cache, then
  flush and get `None` for a missing account.
* `plan_read_swallows_a_stale_fence_and_the_seed_still_runs` — a plan fence
  newer than the cached version makes the directory report stale; `owner_plan`
  returns `None` (the source class's `null`) and the seeder still inserts all 38
  defaults.
* `plan_read_swallows_a_store_failure` — a `MetadataStore` returning
  `StoreUnavailable` degrades to `None`.

Environment contract: `COMMAND_SERVICES_TEST_MONGO_ACK=disposable`,
`..._MONGO_URI`, `..._MONGO_DATABASE=rust_command_services_fixture_<unique>`,
`..._REDIS_URL`, `TZ=UTC`, plus `DIMA_COMMAND_SERVICES_FIXTURE_DIR` (absolute,
outside the workspace) and `..._FIXTURE_SHA256`. The suite refuses a non-empty
database, derives its own per-suite/per-case suffix, drops only those databases,
uses the Redis namespace `command-services-<suffix>:` (the Redis instance must
be task-owned), and never contacts a production service.

## 8. Exact gaps / limitations

1. **Oracle AST boundary** — block compilation is stubbed in the oracle, so the
   `resolve_blocks_literal_tree` case pins this service's envelope, not the
   compiler. The compiler is verified by the existing AST suites; do not read
   this fixture as an AST comparison.
2. **Source-side plan fidelity** — the fixture's plan double models
   `getTwitchAccountById`'s contract (`{plan_tier}` or `null`), not its cache,
   fence or logging internals. Cache hit, stale fence, missing account and store
   failure are exercised only against the real native directory (§7). The
   source class's swallow behaviour is verified from its source
   (`classes/twitch_streamers.class.ts:162-178`), not from a TypeScript oracle.
3. **Write-error message parity** — the two write-error cases compare the error
   class and the stored documents, not the driver message text; the fixture's
   injected messages are source-side evidence only.
4. **`TZ=UTC` is mandatory** for the replayed documents because
   `date.day/month/year` are local calendar defaults recorded under UTC and the
   native `LocalDay/LocalMonth/LocalYear` defaults read local time. The harness
   asserts `TZ=UTC`.
5. **No route wiring** — `src/server/routes/command.route.ts` is not in this
   slice's owned paths. Its `sendBlocksError` mapping needs
   `CommandBlocksRequestError::{status, code, message, block_id}` and the
   `CommandBlocksError::Mongo` 500 path.
6. **Not executed** — no `cargo check`, `cargo fmt`, clippy or test run was
   performed in this authoring wave; compile/format correctness is unverified.
   The type surfaces reuse existing repository types only
   (`ValidationErrors`, `BlocksError`, `CooldownStore`, `DirectoryError`,
   `TwitchStreamers`), and every external API used was read from the current
   tree, but this is not a compiler result.
7. **Redis cleanup** — the directory suites delete the account hash and plan
   fence they touch; the revision/membership keys of a task-owned Redis remain
   under the per-run namespace. Operators should scope or flush that namespace
   after the run.

## 9. Central patch snippets (integration team only)

`dimabot/Cargo.toml` — add one feature next to `commands-service` (position
agnostic, no hunk anchors):

```toml
command-services = ["command-reward-schemas", "ordinary-application-schemas", "command-utils", "twitch-streamers", "redis", "dep:serde_json", "dep:sha2"]
```

Transitive rationale: `command-reward-schemas` → `application-schemas` (mongo,
js-date, js-strings) + `permissions` + `ast-blocks` + `keywords` + `uuid`;
`command-utils` supplies `dep:tokio`/`dep:uuid`/`dep:serde_json`;
`twitch-streamers` supplies `TwitchStreamers` and pulls `twitch-client`,
`logger` and `plan-cache`; `redis` supplies the `ConnectionManager`; `mongo`
supplies `dep:sha2` and `bson_compat`. `ordinary-application-schemas` covers the
`users` collection the disposable fixtures seed. `utils::command_cooldown` is
already registered without a gate; no `utils/mod.rs` or `schemas/mod.rs` change
is required.

`dimabot/src/lib.rs` — two modules, no new `mod.rs`; suggested anchor after the
existing `validation_route` block (any stable position works):

```rust
#[cfg(feature = "command-services")]
#[path = "server/services/command_defaults.service.rs"]
pub mod command_defaults_service;

#[cfg(feature = "command-services")]
#[path = "server/services/command_blocks.service.rs"]
pub mod command_blocks_service;
```

No other central file changes. The path attribute is required because the
service files keep their dotted TypeScript names; `src/server/services/tts/mod.rs`
already establishes that precedent for this directory.

## 10. Files authored

| Path | SHA-256 |
|---|---|
| `dimabot/src/server/services/command_defaults.service.rs` | `138d339b03534c2d7f682079290fcc43e118d297e33ff307be2d9e48ef025d05` |
| `dimabot/src/server/services/command_blocks.service.rs` | `53187e7e5b77574720c76beb62893c363207e052ad68fd39ec8fc89f6d626fd7` |
| `dimabot/tests/command_services.rs` | `4dd6fcb6754b1e16900602e1745bfefbd49a6e92855ff78a56c994518d69823b` |
| `dimabot/tests/support/command_services_support.rs` | `cb92877f919b14953eda5c712b126afb39944c36623268f963328e0b9e3b4730` |
| `dimabot/tests/fixtures/command_services_reference.cjs` | `129921f06339f882a8fa13903ecd18f7b09b6ba60c041ccaf9158cdd6c530626` |
| `migration-notes/command-services-handoff.md` | recorded in the slice result (a file cannot carry its own digest) |

Line counts: defaults 588, blocks 370, test 1102, support 211, oracle 534.

## 11. Verification performed (static only)

* `git diff --check` on the checkout and per-file `git diff --no-index --check`
  for every authored path (whitespace/blank-EOF only); no central file was
  modified by this slice.
* SHA-256 digests of every authored file recorded in the slice result.
* Source digests pinned by the oracle were recomputed from the current tree at
  authoring time and embedded.
* No build, formatter, linter, Node, Docker, network or test execution was
  performed, and nothing was committed.
