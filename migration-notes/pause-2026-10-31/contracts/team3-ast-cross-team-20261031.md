# team3-bot-ast — cross-team contract registry

Recorded by: team3 lead (MiniMax M3.1 Flash via MiniMax Code)
Date: 2026-10-31
Root thread: `9cc467f1-f5c3-45a8-989a-e8e02361df4b`
Authoring only — no execution lease was granted to team3 in this wave.

**Ownership rule.** Every contract below names exactly **one** owner. team3 does not implement
another owner's scope, does not duplicate another team's policy, and does not treat a missing
adapter as complete. A contract is only closed when its owner's **application-specific adapter**
exists and its own source-parity coverage is authored — a trait, a mock, or a host boundary is not
completion.

---

## Accepted by team3 (raised by team4)

### A. `team3-overlay-template-utf16` — owner **team3-bot-ast** — status: QUEUED (lane G)

**Need.** A minimal **shared** lossless entry/storage extension in the AST syntax and types so a
lone UTF-16 surrogate can survive parsing, persistence and rendering, instead of the overlay
runtime needing its own parser.

**Current boundary (verified in the checkout).**
- `SyntaxEngine::parse(&self, input: &str)` — `dimabot/src/utils/ast_parser/syntax.rs:89`
- `AstNode::Literal { value: String }` — `dimabot/src/utils/ast_parser/types.rs:81`
- `crate::utils::ast_evaluator::JsString` — **already lossless**. (Public path — the physical file
  is `dimabot/src/utils/ast_parser/evaluator/value.rs`, but the crate module is
  `crate::utils::ast_evaluator`, registered at `dimabot/src/utils/mod.rs:128-129` with
  `#[path = "ast_parser/evaluator.rs"] pub mod ast_evaluator;`. `crate::utils::ast_evaluator::value::JsString`
  also resolves. **`crate::utils::ast_parser::evaluator::value::JsString` does NOT exist** — do not
  import that path.)
  `pub struct JsString(Vec<u16>)`, `from_units(Vec<u16>)` retains unpaired surrogates, and
  `to_utf8()` fails with `Unpaired UTF16 surrogate at UTF8 boundary` rather than silently
  replacing the character.

**Constraints.**
- **Reuse** the existing `JsString`/`JsValue` lossless representation. Do not build a second
  string representation.
- **Additive only.** The existing UTF-8 public API and its accepted behaviour must not change.
  A lossless entry point (e.g. a `JsString`-accepting parse path) is added beside `parse(&str)`.
- **Do not change** the protected root `js_*` and `lossless_json` cores.
- No second overlay parser.

**Closure requires (all of them, before this contract may be called closed).**
1. The **exact required examples** from team4 — requested from team4 on 2026-10-31; the lane
   will not close on guessed inputs.
2. Source-parity tests for those examples.
3. **Persistence** interaction covered (the AST is serialised/deserialised — `AstNode` is
   `Serialize`/`Deserialize`, so the literal representation must round-trip).
4. **VM** interaction covered (evaluation and rendering of the retained value).

**Status.** QUEUED. team3's wave-2 completion is primary; the lane runs when a worker slot frees.

---

### B. `team3-overlay-eventsub-remote` — owner **team3-bot-ast** — status: QUEUED (lane H)

**Need.** Canonical **concrete** native adapters for the remote EventSub operations that the
overlay interaction runtime depends on, published from team3's EventSub scope so team4 reuses
them instead of writing a private overlay policy:

- `getEventsubs()` — `dimabot/src/utils/eventsub.ts:452`
- `subscribeTwitchEvent(...)` — `dimabot/src/utils/eventsub.ts:335`
- `unsubscribeTwitchEvent(id)` — `dimabot/src/utils/eventsub.ts:513`
- `getScopes(userID)` — `dimabot/src/functions/users/get_scopes.users.ts:11`

**Ownership correction.** team4's earlier note listed this dependency as team2's. The manifest
assigns `src/utils/eventsub.ts` and `src/functions/users/get_scopes.users.ts` to
**team3-bot-ast**. The owner is team3; team4's overlay lane consumes the published adapters.

**Existing native base (verified in the checkout).** `dimabot/src/utils/eventsub.rs` (412 lines)
already carries `Condition`, `build_expected_condition`, `build_expected_condition_value`,
`subscription_key`, `conditions_equal`, `canonical_condition_json` and the raid/circuit-breaker
helpers. It does **not** carry the three remote adapters. The lane extends that module rather
than creating a parallel one.

**Known source requirements the adapters must honour.**
- `subscribeTwitchEvent` needs `TWITCH_EVENTSUB_SECRET`, the streamer account lookup, the
  existing-subscription lookup (Mongo) unless `ignoreExisting`, the streamer header, the
  **app** access token plus `CLIENT_ID`, and the `eventsub` collection upsert.
- `getEventsubs` needs the app token plus `CLIENT_ID` and paginates the Helix list.
- `unsubscribeTwitchEvent` needs the app token plus `CLIENT_ID`, issues
  `DELETE eventsub/subscriptions?id=<id>`, treats **204 and 404** as success, and deletes the
  local `eventsub` document.

**Status.** QUEUED, behind contract A.

---

## Raised by team3 (owner: team4-speech-media)

These are team3's **outgoing** contracts. team3 owns the AST function-family *source* files; the
service that backs each family is team4's, so team3 will not duplicate that policy.

### C. `team3-ast-tts-family-adapter` — owner **team4-speech-media**
**Need.** A callable native AST service seam for the `tts` family
(`dimabot/src/utils/ast_parser/functions/tts.functions.ts`) so the AST evaluator can reach the
speech/TTS service. The source family spans the `tts`, `tts.speak`, `tts.ai`, `tts.clone` and
`tts.fish` sub-families (see `dimabot/src/utils/ast_parser/tts_settings.test.ts`).
**Blocks.** the `tts` AST family adapter.
**Why.** TTS policy, voice selection, credit gates and synthesis belong to team4. team3's
evaluator cannot re-implement them.

### D. `team3-ast-pet-family-adapter` — owner **team4-speech-media**
**Need.** A callable native AST service seam for the `pet` family
(`dimabot/src/utils/ast_parser/functions/pet.functions.ts`) — pet talk, admission, plan tier and
surface rules.
**Blocks.** the `pet` AST family adapter.
**Dependency.** team4's own `team4-pets-runtime-schemas` contract (owner team2) blocks the pets
runtime itself, so this family inherits that blocker. team3 cannot substitute for it.

### E. `team3-ast-overlay-family-adapter` — owner **team4-speech-media**
**Need.** A callable native AST service seam for the `overlay` family
(`dimabot/src/utils/ast_parser/functions/overlay.functions.ts`).
**Blocks.** the `overlay` AST family adapter.
**Dependency.** team4's `team4-overlay-token` contract (owner team2) blocks the overlay token the
AST overlay family publishes through.

### F. `team3-ast-roulette-family-adapter` — owner **team4-speech-media**
**Need.** A callable native AST service seam for the `roulette` family
(`dimabot/src/utils/ast_parser/functions/roulette.functions.ts`).
**Blocks.** the `roulette` AST family adapter.
**Dependency.** team4's `team4-overlay-token` contract also blocks the roulette publish path.

---

## Explicitly NOT delegated — team3's own open scope

These AST families have **no** application-specific native adapter yet. They are team3's own
scope and are reported as team3 blockers, not as contracts against another team.

| Family | Source (team3-owned) | Native service status |
|---|---|---|
| `channel` | `src/utils/ast_parser/functions/channel.functions.ts` | Twitch channel actions — team3 to port |
| `clip` | `src/utils/ast_parser/functions/clip.functions.ts` | Twitch clips — team3 to port |
| `pin` | `src/utils/ast_parser/functions/pin.functions.ts` | Twitch chat pins — team3 to port |
| `trigger` | `src/utils/ast_parser/functions/trigger.functions.ts` | team3's own event surface |
| `defense` | `src/utils/ast_parser/functions/defense.functions.ts` | team3's own follow-defense service |
| `twitch` | `src/utils/ast_parser/functions/twitch.functions.ts` | team3's own Twitch surface |
| `followage` | `src/utils/ast_parser/functions/followage.functions.ts` | team3's own follow ledger |

**Status of the chat → AST application flow.** It is **not** a closed flow. `chat.send` and
`delay` are served by the native catalog; `announce` is landing in wave 2; the families above
remain unimplemented. The flow must not be described as complete while any required family
returns `Unsupported`.
