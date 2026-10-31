# EventSub remote lane H — authoring only (2026-10-31)

The overlay consumer calls the shared EventSub list, subscription and deletion
operations and the app-authorized user-scopes endpoint. The existing EventSub
condition policy, schema collection and Twitch token/client abstractions are
reused; there is no new overlay-specific policy. The remote methods require
`eventsub`, `twitch-functions` and `ordinary-application-schemas` together. A
caller must pass its token source, client, directory and eventsubs collection;
constructing these adapters performs no I/O.

## Central patch still required

`dimabot/src/functions/mod.rs` does not declare `pub mod users;`. That
declaration is lead-owned. `dimabot/src/functions/users/mod.rs` only exposes
`get_scopes`. Until the declaration lands, `functions::users::get_scopes` is
not part of the crate and the scopes tests cannot compile.

## What this pass changed

- Existing-record comparison follows `serializeCondition`: every populated
  top-level condition key participates, including keys outside `ICondition`.
  Top-level `null` and `''` are dropped. `false`, `0`, `{}`, and `[]` stay.
  Nested objects are key-sorted. Nested `undefined` keys are omitted.
  The first serialized match is the only candidate. A truthy stored `id`
  returns that record; a falsy `id` ends the search.
- `Collection` upsert goes through `prepare_subscription_upsert`, which uses
  the eventsub schema adapter's `prepare_equality_upsert`. Known paths are
  cast, unknown top-level paths are omitted, and schema defaults plus `__v: 0`
  are `$setOnInsert` only. Mixed `condition` keeps unknown keys.
- `toEventsubResponse` coercions use JavaScript `String` / `Number` / `Boolean`
  / truthiness. The condition object is not rewritten through the strict view.
  Raid type uses the raw condition. `todayFollows` stays absent when the
  stored document has no such field.
- Helix `error` fields use JavaScript truthiness. Truthy non-strings are
  `String()`'d. Subscribe status `0` becomes `502`. A falsy `data[0]` is a
  subscribe failure. List cursors use `String(cursor || '')`.
- `getAppToken` failures, including non-missing token-source errors and an
  empty token, return the failed-token envelope. The scopes `catch` stays on
  transport and JSON decode.
- `subscribeTwitchEvent` and `unsubscribeTwitchEvent` credential and Helix
  failures emit the source `console.error` lines through `eprintln!`.
  `getScopes` catch logs `userID`, error text, a Rust backtrace, and an ISO
  timestamp. `getEventsubs` still does not log a missing app credential.
- The `TwitchStreamers` directory impl treats every account lookup failure as
  not found, matching `getTwitchAccountById` and `getTwitchStreamerHeaderById`.
  Token failures still share one user-facing message. `account_token` records
  the refresh category only when that directory was built with a logger.

## Tests authored, not run

`dimabot/tests/ast_eventsub_remote.rs` now covers unknown, empty, null,
`false`, `0`, empty-object, and empty-array condition keys, a falsy `id`
blocking a later match, numeric ids, raid projection, response coercions,
stripped schema-only fields, preserved `todayFollows`, schema default/cast
update documents, and token-source failures without a server.
Loopback cases cover falsy `error: 0`, numeric and object errors, a numeric
cursor, and a falsy `data[0]`. The Mongo case covers insert defaults, cast
`cost`, a dropped unknown field, preservation of `enabled` across a later
upsert, and deletion. Those
loopback and Mongo tests stay ignored. Nothing here was compiled or executed.
No real Twitch or Mongo call was made. This is not acceptance evidence.

## Remaining gaps

- Header-helper cache `debug` lines (`getTwitchStreamerHeaderById`, including
  the success `tokenLength` line) are not emitted here. This adapter has no
  header logger. Refresh-kind detail exists only in `TwitchStreamers` when a
  logger is configured. `getTwitchAccountById`'s own error log is not
  duplicated.
- `console.error` output is `eprintln!` of JSON, not Node `util.inspect`.
  The scopes stack is a Rust backtrace, not a JavaScript stack.
- The subscribe request body is still an `ICondition`. Callers cannot send
  unknown condition keys. Comparison only repairs the stored side.
- A stored condition that is not a document serializes as `{}`. A truthy
  string would be enumerated by `Object.entries`.
- Condition JSON for exotic BSON (binary, decimal, code, regex) is `null`.
  `Int64` values are compared through binary64. Key order is Unicode scalar
  order, not UTF-16, so non-BMP keys can differ. Date text uses
  `try_to_rfc3339_string` and was not executed.
- A non-finite BSON number fails `bson::from_bson` into JSON and the
  projection returns `Err`. A value whose JavaScript `Number()` is `NaN`,
  such as the string `"foo"`, becomes JSON `null`.
- Empty Mixed minimization belongs to schema `save` / `construct`, not to
  this `findOneAndUpdate` path. `__v` is inserted as `0` and is not
  incremented on a later update. Required validators are not run.
- Unsubscribe success is `{"status": 204|404}`, not a fetch `Response`.
  The delete query is URL-encoded; the TypeScript call interpolates `id` raw.
- A non-object truthy `data[0]` fails BSON conversion and returns `Err`
  rather than the source's property-read result.
- Custom `EventsubDirectory` implementations can still return `Err`. Only the
  `TwitchStreamers` impl swallows lookup failures.
- Team4 overlay wiring is outstanding. This lane does not close contract B
  and does not claim migration or dependency completion.

## Source-facing follow-up (authoring only, 2026-10-31)

The typed entry point is preserved; `subscribe_twitch_event_raw` accepts a
`&Bson` condition so JSON-compatible unknown keys and non-document values can
reach both matching and the request body. Consumers needing those values must
call the raw entry point; the typed wrapper still serializes `ICondition`.
Stored arrays and BMP strings now use enumerable index properties, while
numbers and booleans have no enumerable properties. Object keys use UTF-16
ordering, with JavaScript's numeric array-index enumeration applied before
other keys. Array-to-string coercion treats null/undefined elements as empty.
Truthy primitive Helix data now supplies absent properties to the store. The
earlier empty-filter assumption is superseded by the source-filter follow-up
below; callers should not treat malformed Helix data as safe.

Successful unsubscribe returns `{status, ok}` (`ok` is false for 404) and
propagates deletion errors. This is a value representation, not a fetch
`Response`: headers, statusText, URL, body and response methods are absent.
The outgoing ID is interpolated as a raw query (including `&`, with fragment
removed), while local deletion retains the original ID. URL parser edge cases
and exact fetch response semantics remain open for a consumer requiring them.
`getScopes` now follows the source catch when the parsed payload is null.

The new `eventsub_remote_reference.cjs` extracts and transpiles actual source
function declarations, stubs external effects, and writes an explicit oracle
artifact. `raw_conditions_compare_against_actual_source_oracle` compares its
matching cases against the native adapter; ignored loopback and private Mongo
cases exercise raw requests, primitive replies, deletion and scopes. These are
authored, not executed. The source-filter follow-up below adds actual Mongoose
query internals; the oracle still mocks fetch and cannot prove fetch Response semantics.
Existing exotic BSON and non-finite projection limitations remain. Non-BMP
characters in a *string condition* are currently enumerated as Rust Unicode
scalars rather than individual JS UTF-16 code units; lone surrogate values
cannot be represented in ordinary BSON/JSON strings. The prior gaps above for
raw input, BMP non-document conditions, UTF-16 object-key sorting, primitive
responses and encoded deletion queries are superseded by this follow-up.
The central `pub mod users;` patch remains lead-owned; no execution, build,
test, deployment or migration-completion claim is made here.


## Source filter and Mongoose oracle follow-up (authoring only, 2026-10-31)

The source captures `{ id: subscriptionData.id }` separately from the `$set`
object, into which configuration is spread later. The collection adapter now
receives the original source ID independently; overriding `config.id` changes
only the update. The existing `upsert(document)` method and preparation helper
remain available, deriving the filter from the document for legacy callers.
Existing custom stores compile through a default `upsert_with_source_id` that
forwards to `upsert`; a store that performs matching must override it to honor
the distinct filter. The subscription path invokes the new method.

Static trace: Mongoose `Model.findOneAndUpdate` decorates the update with the
version key, `Query._findOneAndUpdate` calls `_castConditions`, `_castUpdate`,
then `helpers/setDefaultsOnInsert`. `cast.js` leaves a nullish filter value in
place. The installed MongoDB driver's `resolveBSONOptions` and command
serialization default `ignoreUndefined` to false, and BSON serializes undefined
as null. Therefore the native operation uses `{id: null}` for an absent source
ID, rather than an empty filter; Mongo null equality can match both missing and
null fields, and a fresh upsert may materialize `id: null`. Explicit null stays
null. The shared schema helper rejects empty equality filters, reinforcing that
the old empty-filter implementation could not execute successfully.

The actual-source fixture now loads the archived source schema (the active
TypeScript schema is retired), captures the call from the active extracted
`subscribeTwitchEvent`, constructs the installed Mongoose model query, invokes
the same casting/default helpers, and BSON-round-trips with the installed
driver's default undefined setting. It emits absent, null, overridden and
normal ID cases. An ignored native comparison checks both resulting filter and
complete update, including defaults; a separate ignored private Mongo case
checks that an overridden ID updates the source-matching document and that a
missing source ID matches an existing missing-ID document. These fixtures and
the implementation are **unexecuted**: no compilation, oracle output, Mongo
behavior, or parity has been verified. Actual query merging, model-level or
connection-level BSON options, schema/source version correspondence, BSON
serialization, and update/default equivalence must be confirmed by executing
the oracle and isolated Mongo cases before acceptance. No deployment or
migration-completion claim follows from this authoring pass.
