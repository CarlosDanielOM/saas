# Overlay token — authoring handoff

Slice `team2-slice-10-overlay-token` of `team2-api-data`.
Workspace: `/root/saas-rust` (shared checkout, branch `master`).
Status: **AUTHORED — NOT RUN.** Nothing here was compiled, formatted, executed,
deployed or committed. Every statement is a static source-reading result.

## 0. Claim-path caveat

`claims/team2-api-data.json` **does not exist** at that path in this checkout (a
working-tree scan and the tracked-file list found no such file), so exact claim
membership could not be verified. Only the paths named or implied by the task
brief were created; no central or other team's file was edited. If the lead
holds that file elsewhere, these five paths must be checked against it before
integration:

```
dimabot/src/utils/overlay_token.rs
dimabot/tests/overlay_token.rs
dimabot/tests/support/overlay_token_support.rs
dimabot/tests/fixtures/overlay_token_reference.cjs
migration-notes/overlay-token-handoff.md
```

## 1. Scope and source mapping

| Source (TypeScript) | Native (this slice) |
|---|---|
| `dimabot/src/utils/overlay-token.ts` (57 lines) | `dimabot/src/utils/overlay_token.rs` |
| retired `utils/crypto.ts` (archived) and `utils/crypto.rs` | reused unchanged |
| source behaviour oracle | `dimabot/tests/fixtures/overlay_token_reference.cjs` |
| oracle reader + disposable Mongo harness | `dimabot/tests/support/overlay_token_support.rs` |
| checks | `dimabot/tests/overlay_token.rs` |

Retired sources used only as oracle inputs:

* `archives/dimabot-typescript/2026-10-28/src/utils/crypto.ts` (the real AES-256-CTR
  implementation, loaded by the oracle).
* `src/roulette/model.ts` (live; its real `fail` is the rejection source).

## 2. Traced callers (all still TypeScript)

| Caller | Use |
|---|---|
| `src/widgets/service.ts:1,185-209` | per-channel store on `widget_channels`, premium gate, `remember` on overlay auth |
| `src/roulette/service.ts:1,123-146` | per-channel store on `roulette_channels`, `remember` on overlay auth |
| `src/duel/service.ts:1,58-84` | per-channel store on `duel_widgets`, premium gate, presence-key deletion after a version change |
| `src/pets/tokens.ts:4,10-29` | per-owner store on `pet_runtimes`, `$inc`-free save, pet invalidation after a replacement, capability lookup by `tokenHash` |
| `src/server/routes/widgets.route.ts:33-34`, `roulette.route.ts:32-33`, `duel-widget.route.ts:21-22`, `pet.route.ts:64-68` | `GET`/`POST .../overlay-token`; routes pass `req.body ?? {}` |

The four stores are **other teams' paths** and were not edited. The native
`src/widgets/service.rs` and `src/roulette/service.rs` in this checkout are
another lane's provisional ports (gated by the not-yet-declared
`widgets-runtime` feature and explicitly waiting on this module); the duel and
pet services have no Rust port at all. Caller adoption is therefore **0 of 4**
and is reported as a gap, not as completion.

## 3. Reuse (nothing re-ported)

| Existing native module | Satisfies |
|---|---|
| `utils::credential_crypto::{CredentialCipher, StoredCredential, CredentialCryptoError, hex}` | the retired `encrypt`/`decrypt` codec, AES-256-CTR with the legacy 128-bit counter, `padEnd(32)` key rule, `Buffer.from(hex)` permissiveness |
| `sha2::Sha256` + `utils::credential_crypto::hex` | `createHash('sha256').digest('hex')` |
| `getrandom::fill` | `randomBytes(32)` |
| `utils::lossless_json::JsonValue` + `utils::js_string::JsString` | `unknown` request bodies with JS key/`undefined` semantics |
| `mongodb::bson` + `mongodb::error::Error` | the CAS document and typed store errors |
| `schemas::pet_runtime` (already in this checkout) | `pet_runtimes` collection, `tokenHash` unique partial index, `overlayToken` envelope contract |

No base64 crate was added: the unpadded base64url encoder is 30 lines and is
covered by the oracle's `Buffer.toString('base64url')` comparison.

## 4. Behaviour traced against the source

| Source | Native |
|---|---|
| `overlayTokenHash = sha256 hex` | `sha256_hex` |
| `storedOverlayToken = {tokenHash, overlayToken: encrypt(token)}` | the store call receives the same hash/envelope; the adapter writes `$set: {tokenHash, overlayToken}` |
| `/^[\w-]{43}$/` | `token_shape` (ASCII `\w`, plus `-`) |
| `readOverlayToken` → `state(doc)` | `read_overlay_token` → `token_state` |
| `state` catches decryption errors | `token_state` uses `decrypt(...).ok().flatten()`; other crypto errors propagate |
| `!token \|\| hash(token) !== doc.tokenHash` | `!token.is_empty() && token_hash == hash(token)` |
| `exists: !!doc.tokenHash`, `version: doc.tokenHash ?? null` | `is_linked` (so `''` is unlinked) and `version: token_hash.clone()` (so `''` survives) |
| body must be a non-array object; keys ⊆ `{rotate, version, token}`; `rotate` boolean; `rotate && token !== undefined` rejected | `parse_request`, before the first read |
| token must be a string matching the shape | `parse_request` |
| eight compare-and-set attempts | `MAX_ATTEMPTS = 8` |
| provided token: stored version must match, save with `replace=false` | same; `overlay_link_invalid` / 409 |
| no rotate + linked: return the current view, or `overlay_link_recovery_required` / 409 | `token_state(...).token.is_none()` → `RECOVERY_REQUIRED` |
| rotate: `body.version !== (doc.tokenHash ?? null)` → `overlay_link_conflict` | `version_conflicts`, including the absent-vs-null distinction |
| create/replace: `randomBytes(32).toString('base64url')`, save with `replace=true` | `random_token` + save |
| rotate save loss → immediate conflict; create save loss → retry | same; final loss → "reload before trying again" |
| `rememberOverlayToken`: exact hash equality, only when the current view has no token, save result ignored | same; a save failure still propagates |
| errors propagate to the caller | `OverlayTokenError::{Rejected, Crypto, Store}`; the driver error is kept as `source()` |

Constructor/import contract: the module declares no statics that read process
configuration. `NativeOverlayTokenCodec::new` takes a built cipher;
`NativeOverlayTokenCodec::from_env` is the explicit `SECRET_KEY` boundary.
`MongoOverlayTokenStore::new` only stores a `Collection` handle and the id; it
does not connect, create a collection, install an index, read or spawn.

## 5. Adapter differences (deliberate, recorded)

1. **One encryption per write.** The source encrypts once for the store update
   and again for the returned view (`storedOverlayToken` in both places), so the
   two envelopes can use different IVs. The native writer encrypts once and
   reuses that envelope for the view. Hash, plaintext, decisions and the
   persisted envelope are identical; the envelope never leaves the server. The
   oracle compares the persisted (first) envelope byte-for-byte.
2. **Typed store error.** The source lets the raw driver error escape. The native
   adapter wraps it in `OverlayTokenError::Store` so a caller can still
   distinguish a duplicate key from a network failure (`source()` preserves it).
3. **CAS on an absent field.** Mongoose drops an `undefined` filter path, so a
   document whose `tokenHash` field is absent makes the source filter `_id` only.
   The native adapter always keeps `tokenHash` (`null` for absent), which still
   matches an absent field but does not degenerate. This is stricter, not equal;
   recorded in the fixture boundary text.
4. **Strict document decode.** A non-string `tokenHash` or a non-document
   `overlayToken` is a storage error in the adapter. The source's untyped Mongoose
   schema would cast or pass through; the four owners' schemas already declare
   `String`/`Mixed`, so only malformed legacy rows are affected.
5. **Version strings with lone surrogates.** Lossless JSON can carry an escaped
   lone surrogate. The source compares it as a string and conflicts; the native
   `version_conflicts` treats "not representable as UTF-8" as a conflict too.

## 6. Source oracle

`tests/fixtures/overlay_token_reference.cjs` transpiles and executes the **real**
`src/utils/overlay-token.ts`, the **real** archived `utils/crypto.ts` and the
**real** `src/roulette/model.ts` `fail`. It never contacts a database, cache,
Twitch endpoint or network.

Boundaries (also embedded in the fixture's `boundaries` field):

* `src/utils/crypto.ts` is retired; the archived actual source performs real
  Node AES-256-CTR, so the codec cases compare Node and Rust ciphertext directly.
* `node:crypto.randomBytes` is the only injected primitive: a deterministic,
  recorded generator. `createHash`, `createCipheriv` and `createDecipheriv` are
  Node's own.
* The store is an in-memory fake with the source's `read`/`save` signature; it
  records the exact `expectedHash`, `replace`, hash and envelope of every save,
  and can be scripted to lose a CAS or to fail.
* `SECRET_KEY` is a synthetic fixture key, not a credential.
* Requires Node 24.22.1, V8 13.6.233.17-node.58 and TypeScript 5.9.3;
  the writer rejects another toolchain, and the native reader checks provenance.
  The archived actual `crypto.ts` is a required frozen fixture input.

Case inventory: 12 `read`, 39 `manage`, 7 `remember` = **58** state-machine
cases plus **2** codec round trips. The `manage` group is 13 validation, 6
creation, 9 rotation/creation-retry, 8 replacement and 3 error paths. They cover validation before storage,
JavaScript truthiness of `tokenHash`, unreadable/empty/short IVs, hash
mismatches, creation idempotency, the rotate version matrix (absent, null,
stale, current, `''`), replacement with a live/hash-only/unlinked link, recovery,
CAS retry and exhaustion (create and replace), immediate rotate conflict,
`remember` no-ops and its failure, and store read/save failures.

Run (isolated toolchain only; never host Node):

```text
node tests/fixtures/overlay_token_reference.cjs --write <absolute-empty-dir>
node tests/fixtures/overlay_token_reference.cjs --check <absolute-dir>
```

## 7. Private checks (`tests/overlay_token.rs`)

Un-gated `#[tokio::test]` (no service or environment):

* hash vector, base64url vectors, the complete 43-character shape table;
* `token_state` truthiness: matching envelope, hash-only, mismatched hash,
  `''` hash, malformed IV, empty envelope, decryption failure swallowed;
* request validation order (13 bodies) with **zero** store reads;
* creation idempotency, replacement CAS shape, stale/unlinked rejection;
* `''`-hash branching and its CAS `expectedHash`;
* rotate conflict matrix and current-version rotation;
* recovery requirement, `remember` upgrade, no-ops, lost CAS ignored, save
  failure propagated, empty-token envelope;
* CAS retry, replacement retry, both exhaustion paths, immediate rotate conflict;
* entropy/encryption failures surface as `OverlayTokenError::Crypto`, never as a
  request rejection.

`#[ignore]` oracle replay:

* `source_oracle_replays_the_typescript_state_machine` — verifies fixture/oracle
  /source digests, the 58-name inventory, then for every case replays the exact
  recorded entropy (per-size draws), the store plan, the read count, every save
  (`expectedHash`, hash, `replace`, envelope) and the final document, and
  compares the native view or the rejection code/status/message (or the store
  error text). Codec cases compare `sha256`, the exact IV/ciphertext produced by
  Node's AES-256-CTR, and decryption.

Disposable MongoDB (2 suites + 1 loopback, never a production resource; unique
`rust_overlay_token_fixture_` prefix, empty-database assertion, per-suite suffix,
drop only that database):

* `compare_and_set_creation_rotation_and_recovery` — inert construction;
  creation bumps `revision`; idempotent second call; stale/current rotation;
  replacement without a bump; lost envelope → recovery → `remember` upgrade
  without a bump; absent `tokenHash` field; concurrent creation converges on one
  token.
* `scoping_shapes_and_the_optional_guard` — two stores cannot see or write each
  other; stale expected hash loses the CAS and writes nothing; save never
  upserts; a non-revision store leaves `revision` untouched; non-string hash and
  non-document envelope are storage errors; missing document is a storage error;
  the optional `EnsureOverlayTokenDocument` guard creates the document before
  the read.
* `store_failures_keep_the_driver_error` — no server is started; a loopback
  `127.0.0.1:1` client with a 100 ms selection deadline yields
  `OverlayTokenError::Store` for read and save.

Environment contract:

```text
DIMA_OVERLAY_TOKEN_FIXTURE_DIR=<absolute dir outside the workspace>
DIMA_OVERLAY_TOKEN_FIXTURE_SHA256=<sha256 of overlay-token-reference.json>
OVERLAY_TOKEN_TEST_MONGO_ACK=disposable
OVERLAY_TOKEN_TEST_MONGO_URI=mongodb://127.0.0.1:27017
OVERLAY_TOKEN_TEST_MONGO_DATABASE=rust_overlay_token_fixture_<unique>
```

No Redis, Twitch or HTTP dependency is needed.

## 8. Consumer contracts

The public surface is stable for all four owners:

```rust
pub trait OverlayTokenCodec {
    fn hash(&self, token: &str) -> String;
    fn encrypt(&self, token: &str) -> Result<StoredCredential, CredentialCryptoError>;
    fn decrypt(&self, envelope: Option<&StoredCredential>) -> Result<Option<String>, CredentialCryptoError>;
    fn random_token(&self) -> Result<String, CredentialCryptoError>;
}
pub trait OverlayTokenStore {
    fn read(&self) -> StoreFuture<'_, OverlayTokenDocument>;
    fn save(&self, expected_hash: Option<String>, token_hash: String,
            overlay_token: StoredCredential, replace: bool) -> StoreFuture<'_, bool>;
}
pub async fn read_overlay_token(store: &dyn OverlayTokenStore, codec: &dyn OverlayTokenCodec)
    -> Result<OverlayTokenView, OverlayTokenError>;
pub async fn manage_overlay_token(store: &dyn OverlayTokenStore, codec: &dyn OverlayTokenCodec,
    input: &JsonValue) -> Result<OverlayTokenView, OverlayTokenError>;
pub async fn remember_overlay_token(store: &dyn OverlayTokenStore, codec: &dyn OverlayTokenCodec,
    token: &str) -> Result<(), OverlayTokenError>;
```

`OverlayTokenView { token: Option<String>, exists: bool, version: Option<String> }`
serialises exactly as `{token, exists, version}`. Error mapping for the three
roulette-style services:

```rust
impl From<OverlayTokenError> for ServiceError { // or OverlayError
    fn from(error: OverlayTokenError) -> Self {
        match error {
            OverlayTokenError::Rejected(r) => Self::Domain(fail(r.code, r.message, r.status)),
            OverlayTokenError::Crypto(e) => Self::Storage(e.to_string()),
            OverlayTokenError::Store(e) => Self::Storage(e.to_string()),
        }
    }
}
```

### 8.1 Widgets (`widget_channels`, revision)

Owned by `src/widgets/service.rs`. Replace `WidgetChannelTokens` and the
provisional imports with the adapter plus a guard that reuses the existing
`load_widget` (same module, so its current visibility is enough):

```rust
use crate::utils::overlay_token::{
    EnsureOverlayTokenDocument, MongoOverlayTokenStore, NativeOverlayTokenCodec,
    OverlayTokenCodec, OverlayTokenDocument, OverlayTokenError, OverlayTokenStore,
    OverlayTokenView, StoreFuture, manage_overlay_token, read_overlay_token,
    remember_overlay_token, sha256_hex, token_shape,
};

struct WidgetTokenGuard { channels: Collection<Document>, channel_id: String }
impl EnsureOverlayTokenDocument for WidgetTokenGuard {
    fn ensure<'a>(&'a self, _: &'a Collection<Document>, _: &'a str) -> StoreFuture<'a, ()> {
        let channels = self.channels.clone();
        let channel_id = self.channel_id.clone();
        Box::pin(async move {
            load_widget(&channels, &channel_id).await
                .map_err(|error| OverlayTokenError::Store(MongoError::custom(error.to_string())))?;
            Ok(())
        })
    }
}

fn token_store(&self, channel_id: &str) -> Box<dyn OverlayTokenStore> {
    Box::new(
        MongoOverlayTokenStore::new(self.channels.clone(), channel_id)
            .incrementing_revision()
            .ensuring(Arc::new(WidgetTokenGuard {
                channels: self.channels.clone(),
                channel_id: channel_id.to_owned(),
            })),
    )
}
```

Behaviour to keep in the service: `require_premium` before both token entry
points; `token_exists` stays an `_id + tokenHash` existence query;
`remember_overlay_token(...).catch(...)` must ignore recovery failures after a
successful overlay authentication.

### 8.2 Roulette (`roulette_channels`, revision)

Same shape on `src/roulette/service.rs`: guard calls the existing `load_channel`,
store uses `.incrementing_revision()`. No premium gate in this service (the route
uses channel access instead). `authorizeOverlay` keeps the shape check and the
`exists({_id, tokenHash})` probe, then a best-effort `remember`.

### 8.3 Duel (`duel_widgets`, revision) — no native port yet

Contract only; the service must be ported by its owner.

* Guard: `load_duel(id)` (creates the default settings document, tolerating a
  duplicate-key race), then `.incrementing_revision()`.
* `overlay_token_state`: `require_premium`, then `read_overlay_token`.
* `update_overlay_token`: `require_premium`; read the view **before**; manage;
  when `before.version != result.version`, `DEL widgets:duel:<id>:connected`
  (the source awaits this delete, so a failure propagates after the write).
* `rotate_duel_token`: `state = overlay_token_state(id)`, then
  `manage({rotate: true, version: state.version})`; the returned token must be
  non-null or the caller reports a storage failure.
* `authorize_duel_overlay`: `^[0-9]{1,30}$` channel, `token_shape` token,
  premium, then `exists({_id, tokenHash})`; `remember` is best-effort.
* Health presence (`overlayActive`) compares `hash === tokenHash`; it is outside
  this module.

### 8.4 Pet (`pet_runtimes`, owner id, no revision) — no native port yet

Contract only; the service must be ported by its owner.

* Document: `id = ownerId` (a Mongo `_id` string), not the channel id. The
  native schema already exists: `schemas::pet_runtime::runtime_collection(db)`,
  with the same `tokenHash` unique partial index and `overlayToken` envelope.
* Guard: replicate `runtimeFor(ownerId, channelId)` — one upsert with
  `$setOnInsert {channelId, generation: 1, activeRequestId: null, lease: null,
  notBefore: epoch, lastAcceptedAt: null, tokenHash: null, overlayToken: null}`.
  The guard must capture `channelId` itself.
* Store: `MongoOverlayTokenStore::new(runtime_collection(db), ownerId)` with
  **no** `.incrementing_revision()`; `pet_runtimes` has no revision field.
* Save wrapper (exact side effect):

```rust
impl OverlayTokenStore for PetTokenStore {
    fn read(&self) -> StoreFuture<'_, OverlayTokenDocument> { self.inner.read() }
    fn save(&self, expected_hash: Option<String>, token_hash: String,
            overlay_token: StoredCredential, replace: bool) -> StoreFuture<'_, bool> {
        Box::pin(async move {
            let matched = self.inner.save(expected_hash, token_hash, overlay_token, replace).await?;
            if matched && replace { self.invalidate_pet(self.owner_id.clone(), "overlay_rotated").await?; }
            Ok(matched)
        })
    }
}
```

  The invalidation runs after the CAS succeeded and its failure propagates (the
  token stays rotated, as in the source). A duplicate `tokenHash` (astronomically
  unlikely) surfaces as `OverlayTokenError::Store`; do not retry it.
* `pet_overlay_token(ownerId, channelId, input?)`: `getPetConfiguration` first;
  `input == None` → `read_overlay_token`; otherwise `manage_overlay_token` with
  `fail` mapped to `PetError(code, status)` (the message is discarded by the
  source).
* Capability authentication stays in the pet service: `token_shape`, then
  `findOne({tokenHash})`, then `getPetConfiguration(runtime._id,
  runtime.channelId)`; the pet service never calls `remember`.

## 9. Central patch snippets (integration only)

`dimabot/Cargo.toml` — one feature (any stable position; no hunk anchors):

```toml
overlay-token = ["credential-crypto", "lossless-json", "mongo"]
```

Transitive rationale: `credential-crypto` supplies the cipher, `aes`, `ctr`,
`getrandom` and `serde`; `lossless-json` supplies `serde_json`, `js-strings` and
`JsonValue`; `mongo` supplies MongoDB, `futures-util`, `sha2`, `tokio` and
`bson`. No new dependency is introduced.

`dimabot/src/utils/mod.rs` — one module gate (alphabetical, after
`observability` and before `plan_cache_fence`; any stable position is fine):

```rust
#[cfg(feature = "overlay-token")]
pub mod overlay_token;
```

No `src/lib.rs` change is required (`pub mod utils;` already exists). No
`[[test]]` entry is needed: `tests/overlay_token.rs` is auto-discovered and its
crate-level `#![cfg(feature = "overlay-token")]` makes it empty without the
feature. Do **not** add `overlay-token` to a worker profile: this slice registers
no worker, and the store owners wire their own service features.

## 10. Files authored

| Path | SHA-256 | Lines |
|---|---|---|
| `dimabot/src/utils/overlay_token.rs` | `3c643c87c48e419b87e0de07978b80f0b81007ec318f7259679d5acb5694469d` | 714 |
| `dimabot/tests/overlay_token.rs` | `1c1b3783f0c724e96ce29660a52bd0b6a06b428e4f1261345884cda42d26f0db` | 1422 |
| `dimabot/tests/support/overlay_token_support.rs` | `6efbda55d31c4e11aac36af7138612d76147644cdb60798c58e17c89c97a9124` | 165 |
| `dimabot/tests/fixtures/overlay_token_reference.cjs` | `fbc28cc988e2834afd8fde96a658c89eb67f944183825916582ee8c6ef8b9479` | 446 |

`migration-notes/overlay-token-handoff.md` cannot carry its own digest.

Source digests the oracle pins at generation time (re-verified by the support
reader on every run):

| Source | SHA-256 |
|---|---|
| `dimabot/src/utils/overlay-token.ts` | `15fb6e923540d72bc046ac391bb24b665b6f6b8952feaf719a86e5cb8f64ebbe` |
| `archives/.../src/utils/crypto.ts` | `6d2cd4ed54d87a3d0daf0ad7548d02dda07990eb5b3279e613aa260b4d3b2f71` |
| `dimabot/src/roulette/model.ts` | `9bf92ba7d2808779f0ab3d228dc529e509085f7e51010ab8ef32aa17bb811217` |

Consumer sources traced but not changed:

| Source | SHA-256 |
|---|---|
| `src/widgets/service.ts` | `1a63fb338b749d1698623e60501346a3b7f25970b984125e7b34c9d810dbc150` |
| `src/roulette/service.ts` | `8432cbd6797d12c8cc0dd8a482e4fc054ffa3450bc9f8c7bea8ebe8d733d5b8e` |
| `src/duel/service.ts` | `78c879b17e23fc3f8a504334f4547637368ff5851eb844eccf5b82016373017d` |
| `src/pets/tokens.ts` | `e06a920dea791abd0baa997ac34f62f340e3c21f2e093b1a02fcee2bfd533660` |
| `src/schemas/pet_runtime.schema.ts` | `64b14ec7a0173bf6fc77d41b3bf302c834e44552ce534ded62dc964699cf2fc3` |
| `src/schemas/pet_runtime.schema.rs` | `5cdf6fceb8dcc3d33ba7e169014ccef3e17050a414e206310633dd4d9ac9c542` |

## 11. Coverage and remaining dependencies

**Local feature coverage (this slice):** the canonical state machine, the native
codec (real cipher/SHA-256/entropy), the reusable Mongo CAS adapter with an
optional create-if-missing guard, the actual-source oracle and private bulk,
oracle-replay and Mongo checks are authored. They are **not executed**.

**Not complete / not adopted (separate work):**

1. **No consumer was switched.** The four application stores remain TypeScript.
   The browser-facing routes and their premium/access gates are unchanged.
2. **The provisional native widget/roulette services are another lane's files**
   and still import `roulette_runtime::service`'s provisional codec. This slice
   offers the replacement (8.1, 8.2) but did not edit them.
3. **Duel and pet have no native service port.** Sections 8.3/8.4 are contracts,
   not implementations; the pet invalidation bridge (`invalidatePet`), Dragonfly
   presence deletion and `getPetConfiguration` are prerequisites owned by their
   teams.
4. **The module is not registered.** Without the Cargo feature and
   `utils/mod.rs` gate in §9, nothing in this slice compiles into the crate.
5. **No execution evidence.** No `cargo check`, `cargo test`, clippy, rustfmt,
   Node, Docker or fixture generation was performed. Compile, format, oracle
   generation and runtime behaviour are unverified. The fixture pins TypeScript
   5.9.3 and records Node; a toolchain change must update it deliberately.
6. **Coverage shape.** The oracle covers JSON-representable bodies only; a
   non-JSON `undefined` token/version cannot reach the HTTP route (routes pass
   `req.body ?? {}`). Lone-surrogate version strings are handled defensively but
   are not in the oracle corpus.

## 12. Static verification performed

* Traced every import/caller listed in §2 from the current tree.
* `git diff --check` on the checkout: no output.
* `git diff --no-index --check /dev/null <file>` for every authored path: no
  whitespace/blank-EOF diagnostics.
* A string/comment-aware bracket balance scan over the four authored files:
  balanced.
* SHA-256 digests and line counts recorded in §10.
* No `unsafe`, `todo!`, `unimplemented!` or `unwrap()` in the library module;
  `std::env` only inside `NativeOverlayTokenCodec::from_env`, and `getrandom`
  only inside `NativeOverlayTokenCodec::random_token`.
* No build, formatter, linter, Node, Docker, network or test execution; nothing
  was committed, pushed or deployed.
