# Pub/Sub manager — authoring handoff

Slice `team2-slice-12-pubsub-manager` of `team2-api-data`.
Workspace: `/root/saas-rust` (shared checkout). Authoring only: no Cargo,
rustfmt, Node, tests, Docker, network, installs or deployment were run, and
nothing was committed. Every statement below is a static source/reading result,
not an execution result.

## 1. Scope and source mapping

| Source (TypeScript) | Native (this slice) |
|---|---|
| `dimabot/src/classes/pubsub_manager.class.ts` | `dimabot/src/classes/pubsub_manager.class.rs` |
| — (no source test file exists) | `dimabot/tests/fixtures/pubsub_manager_reference.cjs` (authored source oracle) |
| — | `dimabot/tests/pubsub_manager.rs` |
| — | `dimabot/tests/support/pubsub_manager_support.rs` |

Owned paths only. Central files (`dimabot/Cargo.toml`, `dimabot/src/lib.rs`,
`dimabot/src/utils/mod.rs`) were **not** touched; the required snippets are in
§6. No other team's file was edited, including `dimabot/src/speech/session_reset.rs`,
`dimabot/src/utils/keywords/native.rs`, `dimabot/src/handlers/clip_queue.handler.ts`
and `dimabot/src/server/index.ts`.

## 2. Reuse (nothing re-ported)

* **Dragonfly/Redis connection** — the manager takes an already opened
  `redis::Client` (the same driver version and configuration as
  `crate::utils::redis::get_redis_client`, `redis` 1.7.1, `connection-manager`,
  response timeout unset for the shared manager). It does **not** re-read
  `DRAGONFLY_HOST`/`DRAGONFLY_PORT` and adds no second connection factory.
* **`PUBLISH` adapter pattern** — identical to
  `crate::speech::session_reset::RedisSessionPublisher`
  (`redis::cmd("PUBLISH") … query_async`); that type's own doc comment says the
  canonical manager should replace it (§5.1).
* **Subscriber loop pattern** — the dedicated-socket + shutdown shape follows
  `crate::utils::keywords::native` (`get_async_pubsub`, `on_message`, `Drop`
  aborting the task) and `crate::domain_event_runtime::wakeups`
  (`DomainEventWakeupListener`: bounded connect/subscribe timeout, reconnect
  wait, `Drop` abort). Neither is duplicated: `keywords:changed` stays owned by
  `NativeKeywordCache::start_subscription`, and `domain-events:wakeup:v1` stays
  owned by `DomainEventWakeupListener` (a single-channel, timeout-bounded hint
  listener that the generic manager does not replace — see §5.4).
* **JSON** — `crate::utils::lossless_json::{JsonValue, parse_json}` supplies
  `JSON.parse`/`JSON.stringify` semantics, including escaped lone surrogates,
  ECMAScript number spelling and canonical-index key ordering.
  `crate::utils::js_string::JsString` supplies UTF-16 code units for the
  string-spread case.
* **Clock** — `crate::utils::logger::Clock::now_millis` is exactly `Date.now()`;
  no new clock trait was added.
* **Logger** — `crate::utils::logger::{Logger, Level, Destination, LogOptions}`,
  same `{ function, error }` payloads and destinations as the source.

## 3. Behavior traced against the source

Source state: `publisher`, `subscriber`, `subscriptions: Map<channel, handler>`
(one handler per channel), plus a module singleton `pubSubManager`.

| Source behavior | Native |
|---|---|
| `init()`: `getDragonflyClient('PubSubManager:init')`, `duplicate()` twice, attach `message`/`error` listeners, `await subscriber.connect()`, `await publisher.connect()`, `info({message:'PubSub manager initialized'}, {destination:'console'})` | `init()`/`ensure()` → `connect()`: `client.get_async_pubsub()` first, then the publisher connection, one dispatch task, the same info payload and `Destination::Console`. Idempotent. |
| `init()` failure: `error({function:'PubSubManager.init', error}, {destination:'both'})` then `throw` | `ensure()` logs the same payload at `Destination::Both` and returns `PubSubError` |
| `publish(channel, data)`: initialize when `publisher` is unset; `JSON.stringify({...data, timestamp: Date.now()})`; `publisher.publish` | `publish` → `ensure()` → `payload_with_timestamp(data, clock.now_millis())` → `PUBLISH` |
| `subscribe(channel, handler)`: initialize when `subscriber` is unset; `subscriptions.set(channel, handler)`; `subscriber.subscribe(channel, cb)`; the callback re-reads the handler from the map | `subscribe`: registry `set` (one handler per channel), `SUBSCRIBE` awaited through `PubSubSink`; the dispatch task re-reads the registry per message |
| `unsubscribe(channel)`: only when `subscriber` exists; `await subscriber.unsubscribe(channel)`; `subscriptions.delete(channel)` | identical order; a no-op before initialization, like the `if (subscriber)` guard |
| `handleMessage(channel, message)`: `JSON.parse` → map lookup → handler, inside `try/catch` that logs `{function:'PubSubManager.handleMessage', error}` | dispatch loop: registry lookup → `parse_json` → handler, malformed payloads logged with the same function name and the subscription kept alive |
| message for a channel with no handler | dropped without parsing (the live per-channel listener does the same) |
| `publishClipRequest(channelID, clipData)` → `twitch:${channelID}:clip:request` | `publish_clip_request` + `clip_request_channel` (`CLIP_REQUEST_TEMPLATE = "twitch:{}:clip:request"`) |
| `subscribeToClipRequests(channelID, handler)` | `subscribe_to_clip_requests` |
| `ClipRequestData` interface | compile-time only in the source (no runtime validation); the native payload is a `JsonValue` object built by the clips consumer, and `publish` appends the authoritative `timestamp` (§5.3) |

Payload construction is a real port, not an approximation:

* object spread copies own enumerable fields in JavaScript property order and
  replaces a duplicate key **in place** (`{...{timestamp:1}, timestamp:2}` keeps
  `timestamp` first);
* array and string spreads produce index keys (`{0:…, 1:…}`);
* `null`, booleans and numbers spread to nothing;
* canonical array indices sort before named keys;
* `undefined` fields never reach the wire (they are dropped by `JSON.stringify`
  in the source and are absent from the recorded `dataJson`).

## 4. Deliberate differences, with evidence

All four are recorded as `replay: "source-only"` cases in the oracle so the
evidence is pinned rather than asserted here.

1. **The `subscriber.on('message')` listener is dead code.** In the pinned
   `@redis/client` 5.12.1, `PubSub#emitPubSubMessage` dispatches only to the
   per-channel listener sets (`node_modules/@redis/client/dist/lib/client/pub-sub.js:345-347`),
   and the client never emits a client-level `'message'` event (the only
   `'message'` string in `dist/lib` is the protocol command name at
   `pub-sub.js:18`). The source's `handleMessage` therefore only runs if called
   directly. Its `try/catch` is nevertheless the source's declared
   malformed-payload contract, so the native parses inside the dispatch loop,
   logs `PubSubManager.handleMessage` and keeps the subscription alive instead of
   letting a `JSON.parse` throw escape into the socket reader — which is what the
   *live* per-channel listener does in the source
   (`oracle: malformed_payload_throws_out_of_the_channel_listener`, `threw: true`).
2. **Replacement dispatches once, not once per attached listener.** Re-subscribing
   an already subscribed channel issues no `SUBSCRIBE` and only attaches another
   listener (`pub-sub.js:72-78`), while the source map keeps one handler, so the
   source calls that handler once per attached listener
   (`oracle: subscribe_replacement_calls_the_new_handler_once_per_listener`,
   `second: 2, listeners: 2, commands: 1`). The native registry is the source's
   own `Map` model and dispatches once.
3. **A failed `subscribe` does not leak the handler.** The source sets the map
   entry before awaiting `subscribe` and never rolls it back
   (`oracle: subscribe_failure_keeps_the_handler_in_the_map`, `leakedCalls: 1`).
   The native removes the entry when `SUBSCRIBE` fails.
4. **Initialization is retryable.** After a failed `init()` the source keeps its
   half-connected clients, so the next `publish` skips `init()` and fails on a
   closed client (`oracle: publish_after_a_failed_init_does_not_retry`,
   `caught: "The client is closed"`). The native leaves the manager
   uninitialized and retries on the next operation; a closed dispatch stream
   flips `is_connected()` to `false` and the next operation rebuilds the
   connection, restoring every registered channel (node-redis does the same
   through its own resubscribe path).

Additions that the source has no equivalent for, and why they exist:

* `shutdown()` and `Drop` — the source's clients live for the process lifetime.
  A Rust manager must be able to stop its dispatch task and close its socket.
* `stats()` — `published`, `received`, `malformed`, `handler_failures`.
  `malformed` is the observable form of the `handleMessage` log; it is what the
  invalid-JSON adapter test asserts.
* `catch_unwind` around a handler — `handleMessage`'s `try/catch` catches every
  handler failure, and a native panic would silently kill the dispatch task.

No trait is claimed as completion: `PubSubManager` is a concrete type over a real
`redis::Client`, and every method performs real `SUBSCRIBE`/`UNSUBSCRIBE`/
`PUBLISH` calls. `Clock` and `Handler` are the only seams; `Clock` defaults to
`SystemClock` and `Handler` is an application callback, not a data-access port.

## 5. Consumer contract

### 5.1 `dimabot/src/speech/session_reset.rs` (team4) — replace the raw publisher

`RedisSessionPublisher` publishes the bare payload, so the current native
`tts:session-ended:v1` message has **no `timestamp`**, while the source goes
through the manager and therefore does. The trait's own doc comment asks for
this delegation. Suggested edit (team4 owns the file):

```rust
use crate::utils::{
    lossless_json::parse_json,
    pubsub_manager::PubSubManager,
};

pub struct ManagerSessionPublisher {
    manager: Arc<PubSubManager>,
}

impl SessionPublisher for ManagerSessionPublisher {
    fn publish<'a>(
        &'a self,
        event: &'a str,
        payload: &'a str,
    ) -> SessionFuture<'a, Result<(), SessionResetError>> {
        Box::pin(async move {
            let data = parse_json(payload).map_err(|_| SessionResetError::publish())?;
            self.manager
                .publish(event, &data)
                .await
                .map_err(|_| SessionResetError::publish())
        })
    }
}
```

`SpeechFiles::native(cache, dir, logger)` would then take the shared
`Arc<PubSubManager>` instead of building `RedisSessionPublisher`. The published
wire payload becomes `{"channelID":"…","session":"…","timestamp":…}`.

### 5.2 `tts:session-ended:v1` subscriber (`src/server/index.ts:97-100`)

The source validates the payload before dispatching. The native equivalent must
keep the same gate, including the UTF-16 length rule
(`value.session.length` counts UTF-16 code units):

```rust
use crate::utils::{js_string::JsString, lossless_json::JsonValue};

fn session_ended(data: &JsonValue) -> Option<(String, String)> {
    let channel_id = match data.get("channelID") {
        Some(JsonValue::String(value)) => value.to_utf8_lossy(),
        _ => return None,
    };
    let session = match data.get("session") {
        Some(JsonValue::String(value)) => value.clone(),
        _ => return None,
    };
    let digits = !channel_id.is_empty()
        && channel_id.len() <= 30
        && channel_id.bytes().all(|byte| byte.is_ascii_digit());
    if !digits || session.len() > 64 {
        return None;
    }
    Some((channel_id, session.to_utf8_lossy()))
}

manager.subscribe(
    crate::speech::session_reset::TTS_SESSION_ENDED,
    Arc::new(move |data: &JsonValue| {
        let Some((channel_id, session)) = session_ended(data) else { return };
        let handler = Arc::clone(&tts_queue_handler);
        // The source's handler is `async` and its promise is not awaited.
        tokio::spawn(async move {
            let _ = handler.handle_session_ended(&channel_id, &session).await;
        });
    }),
).await?;
```

`Handler` is `Arc<dyn Fn(&JsonValue) + Send + Sync>`: it is synchronous on
purpose. A consumer that needs async work spawns it, exactly as the source drops
the promise returned by its `async` callback. Handlers must not block; the
dispatch task runs them one at a time in message order.

### 5.3 Clip queue (`clip_queue.handler.ts`, `queue.clip.ts`)

```rust
// publish — the manager appends/overwrites `timestamp`, as the source does.
manager.publish_clip_request(channel_id, &payload).await?;

// subscribe — one handler per channel; the source guards re-subscription itself.
manager.subscribe_to_clip_requests(channel_id, Arc::new(move |data: &JsonValue| { /* … */ })).await?;
```

`ClipRequestData` is a compile-time interface in the source with no runtime
validation; the native consumer builds the `JsonValue` object with the source's
field names (`clipID`, `streamerLogin`, `duration`, `clipUrl`, `title`, `game`,
`streamer`, `profileImage`, `description`, `streamerColor`). Note the source
quirk that is preserved: `requestClip` sets `timestamp: Date.now()` for the
stored payload and the manager overwrites it with a second `Date.now()`, so the
published and stored timestamps can differ by a millisecond.

### 5.4 `keywords:changed` and `domain-events:wakeup:v1` — reuse, do not re-subscribe

`crate::utils::keywords::native::NativeKeywordCache::start_subscription` already
owns the `keywords:changed` subscription, its reconnect loop and its invalidation
counters. `PubSubManager` must **not** be wired for that topic: a second
subscriber would double the connections and the work. `utils/keywords.rs:646`
also publishes that topic directly (`JSON.stringify({channelID})`, no timestamp),
which matches `keyword_cache.ts:47`.

`crate::domain_event_runtime::wakeups::DomainEventWakeupListener` already owns
`domain-events:wakeup:v1` with a bounded connect/subscribe timeout and a
reconnect wait, and `DomainEventWakeups` publishes the hint on that channel
directly. That channel is a readiness hint, not a payload channel, so it stays
with its own listener; `PubSubManager` neither subscribes to it nor replaces it.

### 5.5 Wiring

```rust
let client = redis::Client::open(/* the same host/port as get_redis_client */)?;
let manager = Arc::new(
    PubSubManager::new(client, Some(logger.clone()))
        // Reuse the process-wide multiplexed connection for PUBLISH.
        .with_publisher(crate::utils::redis::get_redis_client().await?),
);
manager.init().await?;
```

`PubSubManager::new` performs no I/O and reads no environment. `with_publisher`
avoids a second publisher socket; the subscriber always needs its own connection.

### 5.6 Caller inventory (traced from the TypeScript tree)

| Caller | Call | Native owner / action |
|---|---|---|
| `src/server/index.ts:41` | `await pubSubManager.init()` | API bootstrap: `manager.init()` (or the first `subscribe`) |
| `src/server/index.ts:97-100` | `subscribe(TTS_SESSION_ENDED, …)` | §5.2 |
| `src/bot/index.ts:43` | `await pubSubManager.init()` | bot bootstrap: `manager.init()` |
| `src/utils/keyword_cache.ts:32` | `subscribe('keywords:changed', …)` | reuse `NativeKeywordCache` (§5.4) |
| `src/handlers/clip_queue.handler.ts:41` | `subscribeToClipRequests` | §5.3 |
| `src/functions/clips/queue.clip.ts:81` | `publishClipRequest` | §5.3 |
| `src/utils/speech.ts:29` (`clearSpeechFiles`) | `publish(TTS_SESSION_ENDED, {channelID, session})` | §5.1 (`speech/session_reset.rs`) |

`src/bot/index.ts` only initializes: it never subscribes or publishes, so that
process holds two idle connections. The source does the same, and the native
`init()` reproduces it. The only test file that mocks the manager,
`src/handlers/dima032_session.test.ts:175`, replaces `publish` with a direct
`handleSessionEnded` call; it constrains no native API.

## 6. Central registration snippets (integration team only)

`dimabot/Cargo.toml`, in `[features]` (for example after `commands-service` at
line 15):

```toml
pubsub-manager = ["redis", "lossless-json", "logger"]
```

That closure supplies `redis` (driver + `connection-manager`), `lossless-json`
(`js_string`, `serde_json`), and `logger` (`tokio` with `rt-multi-thread`/`sync`/
`time`, `futures-util`, `serde_json`). No default or worker profile changes.

`dimabot/src/utils/mod.rs`, beside the other class registrations (anchor:
lines 352-353, `#[path = "../classes/command.class.rs"]` / `pub mod commands;`):

```rust
#[cfg(feature = "pubsub-manager")]
#[path = "../classes/pubsub_manager.class.rs"]
pub mod pubsub_manager;
```

No `lib.rs` entry is needed (the module is reachable as
`dima_rust::utils::pubsub_manager`), and no worker or Compose change is involved.

## 7. Tests authored (not executed)

`dimabot/tests/pubsub_manager.rs`, gated by
`#![cfg(feature = "pubsub-manager")]`.

Pure, no I/O:

* `payload_spreads_fields_then_appends_the_timestamp`
* `payload_replaces_an_existing_timestamp_in_place`
* `payload_spreads_arrays_strings_and_scalars_like_javascript`
* `payload_orders_canonical_indices_before_named_keys`
* `payload_escapes_like_json_stringify` (controls and a lone surrogate)
* `clip_request_channel_matches_the_source_template`
* `registry_keeps_exactly_one_handler_per_channel`

Oracle replay (`#[ignore]`, needs the external fixture):

* `oracle_case_names_are_pinned` — the full 29-case inventory, in order
* `publish_payload_cases_replay_natively` — 13 recorded payloads, byte-exact
* `clip_channel_cases_replay_natively` — 4 recorded channels
* `divergence_evidence_is_recorded` — pins the four §4 facts

Adapter suites (`#[ignore]`, task-owned disposable Redis only):

| Test | Covers |
|---|---|
| `publish_reaches_a_subscriber_with_the_source_payload` | real `PUBLISH` reaches an independent subscriber with the exact source payload and the injected timestamp |
| `subscribe_dispatches_a_published_message` | real `SUBSCRIBE` → parsed `JsonValue` handler, `received` counter, one registry entry |
| `subscribe_replaces_the_handler_and_dispatches_once` | replacement keeps one subscription, one dispatch, old handler never called |
| `unsubscribe_stops_dispatch_and_clears_the_registry` | `PUBLISH` reports 0 receivers afterwards, registry empty, second unsubscribe is a no-op |
| `invalid_json_is_counted_and_the_subscription_survives` | malformed payload is counted, logged by the manager, and the next valid message is still dispatched |
| `connection_failures_are_propagated_and_retryable` | a closed loopback port yields `PubSubError::Redis` twice and `init()` still fails; nothing was published |
| `shutdown_stops_dispatch_and_allows_reinitialization` | shutdown releases the subscription, blocks later messages, then re-initializes on a fresh connection |
| `dropping_the_manager_cancels_the_dispatch_task` | `Drop` aborts the task and releases the subscription |

Environment contract (identical to the repo's other private Redis fixtures):

```text
DIMA_RUST_TEST_RESOURCE_OWNER=dimabot-migration
DIMA_TEST_REDIS_URL=redis://127.0.0.1:<port>/
```

The support file rejects any other owner acknowledgement, any non-allowlisted
host, credentials, TLS, a query or a database index. Every channel is
`dima:test:pubsub:<pid>:<nanos>:<name>`; the suites never publish to an
application channel, never delete or flush anything, and only assert that their
own prefix is released. `connection_failures_are_propagated_and_retryable` binds
and releases a task-owned ephemeral loopback port; it does not touch a listening
service.

Bounded waits (`support::wait_until`, `wait_for_release`) poll a condition the
fixture or the runtime satisfies, up to a deadline; they are readiness waits, not
a cadence, and no suite sleeps while work is ready.

## 8. Source oracle

`dimabot/tests/fixtures/pubsub_manager_reference.cjs`, run by the integration
team in the pinned isolated Node/TypeScript toolchain (never in this wave):

```bash
node tests/fixtures/pubsub_manager_reference.cjs --write <absolute-empty-dir>
node tests/fixtures/pubsub_manager_reference.cjs --check <absolute-dir>
```

It transpiles the **real** `src/classes/pubsub_manager.class.ts`
(sha256 pinned in the file: `809861004ff6f9c53e32a44098ff3f8d63348f49eab976abe57ccf0b763ecc88`)
with `ts.transpileModule`, runs it against an in-memory `redis` double,
`getDragonflyClient` double and logger double, freezes `Date.now()`, and writes
`pubsub-manager-reference.json` with `provenance`, `boundaries`, `constants` and
29 `cases`. Each case carries `replay: "native"` (replayed by
`tests/pubsub_manager.rs`) or `replay: "source-only"` (recorded evidence for §4).

Boundaries recorded in the output: Pub/Sub is an in-memory bus; the double
reproduces `@redis/client` 5.12.1's listener and SUBSCRIBE-command behaviour; the
client-level `'message'` event is never emitted (with the file and line
evidence); `Date.now()` is frozen; error messages from V8 are recorded verbatim
under the pinned Node 24.22.1.

The native side reads the fixture only when
`DIMA_PUBSUB_MANAGER_FIXTURE_DIR` (absolute, outside the workspace) and
`DIMA_PUBSUB_MANAGER_FIXTURE_SHA256` (lowercase hex) are supplied; it verifies
the fixture digest and the oracle digest recorded in its provenance.

## 9. Known gaps and limits

* Nothing was compiled, formatted or run: no `cargo`, `rustfmt`, `node`, test,
  container or network execution happened. The compile, oracle and adapter
  results are unknown until the integration team runs them.
* The module is not registered until the §6 snippets land, so
  `tests/pubsub_manager.rs` cannot build before that.
* No automatic reconnect loop: a closed stream marks the manager disconnected and
  the next operation rebuilds the connection and restores the registered
  channels. The source relies on node-redis's internal reconnect instead.
* A message that arrives for a channel whose handler was registered after the
  subscription but before the registry write would be dropped; the window is the
  `SUBSCRIBE` acknowledgement, which is the same ordering the source has.
* `publish` still initializes the subscriber (source parity), so a publish-only
  consumer holds a subscriber socket. `with_publisher` only removes the second
  publisher socket.
* Two source consumers are deliberately left to their owners: the keyword cache
  subscriber (§5.4, already native) and the clip/TTS handlers (§5.1-5.3).
* No production resource, container, cache, credential or database was read or
  written while authoring this slice.

## 10. Files and digests

| File | sha256 |
|---|---|
| `dimabot/src/classes/pubsub_manager.class.rs` | `5c6c897281af0a532f2506e2786f4ccbc1dd1f6c27791e134c0092f06e3a6860` |
| `dimabot/tests/pubsub_manager.rs` | `3b249f28e82b66146df7cdab55fb45db20dd0ea86b2ff97aecc05f153bc480a1` |
| `dimabot/tests/support/pubsub_manager_support.rs` | `33d41cec2e32eefb0831caedf0b4a8891b35a52bf012c057b02c508a6ece27dc` |
| `dimabot/tests/fixtures/pubsub_manager_reference.cjs` | `8abe3c8d551217b6e978d40b22720b641989d0c328c0ce10f6c03b6601ebb37c` |

These four digests are of the authored files above and were taken with
`sha256sum` after the last edit to each. The oracle pins the **source** digest
inside `pinned.manager`, not the native files.
