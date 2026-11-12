# Text-copy cleanup audit

Scope: `crates/*` and `services/*`, excluding model, socketio, twitch, events, ai and rig,
which are owned by other packages. No old `dima-rust/src` changes. Locations below refer to
`rust-v2` baseline `f6dd3785` before this cleanup; replacement locations move as copies disappear.
Crate paths below are under `crates/`; service paths are under `services/`.
No new external dependencies; telemetry adds a direct workspace dima-text dependency.

## Reused contracts

1. `web/src/body.rs:552,587,604`: parse_js_json, 127 open containers, no additional decoded-text
   size cap (the configured wire/inflated-body limit already applies). Strict/empty-body rules
   stay outside the shared parser. On failure only, serde_json retains the previous diagnostic,
   status 400 and entity.parse.failed. Duplicate keys keep first position/last value.
   Correction: literals ±9007199254740993 round to ±2^53 and now use the same integral storage
   as all integral doubles in that range; old code stored these rounded values as floats.
   Wire JSON remains unchanged. dima-text's canonical representation is right.
2. `web/src/uri.rs:8`: decode_uri_component via the shared Result-to-Option adapter.
   `web/src/qs.rs:507` retains malformed text after replacing + with space; `web/src/path.rs:322`
   and `web/src/send.rs:126` retain errors. No behavioral differences.
3. `web/src/send.rs:669`, `dimadb-server/src/ejson.rs:500`: shared toUTCString/toString UTC.
   All negative years whose absolute value has fewer than six digits now use at least four
   digits: e.g. year -1 is -0001, previously -000001. Node/shared formatter is right.
4. `dimadb-server/src/auth.rs:66`: shared encodeURIComponent. No differences.
5. `core/src/crypto/jwt.rs:322,331,342`, `telemetry/src/aggregate.rs:410`,
   `store/src/dragonfly/cron_queue.rs:508,519`: shared numeric value, truthiness and Number.
   JWT's -0 stays negative instead of becoming integer zero; ±2^53 becomes integral storage
   instead of float. The shared Number/JSON representation is right; serialized JSON unchanged.
6. `http/src/path.rs:64`: template remains strict RFC3986; template_encode_uri_component is
   explicit opt-in for TypeScript URLs. Same validation, including empty/dot segments.

## Additional matches replaced (item 7)

- `core/src/crypto/jwt.rs:354`, `core/src/env/read.rs:246`: shared JSON parsing, previous
  depth 127 and no extra size cap. Large integer literals now round at the parse edge,
  integral floating literals become integers, numeric keys sort before other keys. The old
  source-order/full-integer-precision copy was wrong; shared parser follows Node. -0 remains -0.
- `store/src/dragonfly/cron_queue.rs:440`: same JSON correction for parsed job data, preserving
  the dedicated depth-error preflight and the popped bytes used by acknowledgments/requeues.
- `web/src/qs.rs:302`: shared number-to-text. Beyond the exact integer range the u128 cast
  printed the full binary integer, e.g. 1000000000000000128 versus Node's shortest decimal
  1000000000000000100. Shared formatter is right. Other exponent/shortest-roundtrip differences
  follow the same rule. Existing qs limits remain; canonical-key comparison is corrected below.
- `web/src/qs.rs:289,311`: canonical numeric-key comparison now uses shared number_to_string;
  1000000000000000100 is accepted and 1000000000000000128 rejected, reversing the old binary
  integer test. Node/shared text is right. Decimal parseInt of overflow keys delegates to the
  shared parse_int (same observed outputs, including prefix text and negative zero).
- `web/src/path.rs:60,145`: parameter enumeration uses js_property_order, preserving optional
  undefined values via a keyed lookup. No differences, including the 2^32-1 boundary and 01.
- `web/src/request.rs:510`: !isNaN(Number(header)) through parse_number. Correction: ++1, --1, +-1 and -+1 now fail the check, as Node Number does; the old
  copy stripped a sign and then accepted another. NaN is refused, infinities are accepted,
  whitespace/radix forms preserved.
- `web/src/uri.rs:111`: encodeURI for each encoded character through dima-text; encodeurl's
  own allow-set and preservation of existing escapes remain. No differences.
- `telemetry/src/aggregate.rs:423`: numeric labels use number_to_string before cleaning.
  Corrections: -0.0 becomes 0, integral floats lose .0, numbers use Node's shortest decimal
  and exponent thresholds (then Label cleaning still applies). Node/shared formatter is right.
- `telemetry/src/logger.rs:544,559`: shared locale/ISO date text within Date's range. ISO years
  before 0 and after 9999 now have a sign and six digits (-000001, +010000); old code printed
  -001 and 10000. Shared formatter is right. Historical total-function fallback stays outside
  Date's range, because these internal String-returning APIs have no RangeError channel.
- `dimadb-server/src/ejson.rs:591,611`: shared truthiness and String joining via a view of its
  local BSON-aware value. Symbol remains truthy as an object while its text is the symbol text.
  BSON-specific class handling remains; no differences.

## Matches retained: distinct contracts

- `web/src/qs.rs:195,282`: incremental sparse-query storage partitions numeric keys into a
  BTreeMap and named keys into insertion order. It needs an index classifier, not a sorted key
  list; dima-text's classifier is private. Keep the bounded u32 membership adapter (no format
  implementation) rather than adding repeated sorting to each insertion.
- `http/src/path.rs:9`: strict signing escapes; item 6 adds an opt-in instead of changing them.
- `http/src/redact.rs:83`: deliberately lossy percent decoding for secret-name detection;
  malformed input must not evade redaction. Shared decoding is strict.
- `web/src/uri.rs:83`: encodeurl allow-set/existing escape rules; not encodeURIComponent.
  Its old raw-byte writer at :149 is removed with the shared encodeURI replacement.
- `web/src/multipart/parse.rs:160,283`: RFC5987 bytes plus charset conversion, not UTF-8 URI decoding.
- `web/src/send.rs:660`: radix-16 integer text for ETags, not decimal Number.toString.
- `store/src/mongo/number.rs:30,86`, `store/src/mongo/json.rs:153`: BSON numeric types and
  JSON.stringify's positive-zero output; js_number_value instead preserves negative zero.
- `store/src/mongo/{cast.rs,filter.rs}`: Mongoose schema casts/errors, not generic Number/String.
- `store/src/dragonfly/{queue.rs:89,pubsub.rs:641,error.rs:146}`, `http/src/response.rs:252`:
  typed serde decoders, retaining type validation and structured category/line/column errors.
- `store/src/dragonfly/cron_queue.rs:393`: explicit queue depth-error preflight, retained.
- `dimadb-server/src/ejson.rs:219,233,352,442,1177`: EJSON wrappers, Decimal128/Long exact
  decimal text, raw BSON class String overrides, and ordered BSON entries. Shared helpers
  already handle applicable ISO dates, JSON keys and ordinary double text.
- `dimadb-server/src/js_errors.rs:5`: V8 diagnostic grammar for client-visible syntax errors;
  dima-text has structured errors, not this diagnostic contract.
- `web/src/cors.rs:82,90,97`, `web/src/response.rs:631`, `analytics/src/overview.rs:20`:
  joins of already-typed strings for headers/SQL, not String(value) coercion.
- `tts/src/providers.rs:329`: binary protocol string framing. `email/src/templates.rs:227`:
  abbreviated human numbers (k/M), already reuses shared ordinary number formatting.

## Equivalent candidates outside owned paths (left for their owners)

- `billing/src/js.rs:13,73`: Number and truthiness copies.
- `billing/src/polar/flows.rs:139`, `billing/src/plans/credits.rs:216,273`: untyped JSON parsing
  after surrogate sanitization. `billing/src/polar/mod.rs:221` is a typed decoder.
- `billing/src/usage.rs:314`, `billing/src/polar/ingest.rs:123`,
  `commands/src/permissions/roles.rs:189`: finite-number JSON construction; ingest explicitly
  folds -0 to +0 for the wire. Review representation before using js_number_value.
- `engine/src/value.rs:103,139,150,164,326`: custom Value text/truthiness/Number/JSON parser
  and writer; plausible shared-view/parser candidates, but engine is outside ownership.
- `hoststats/src/docker.rs:159`: typed JSON decoder after surrogate sanitization.
  `hoststats/src/parse.rs:4`, `commands/src/value.rs:84,89`, `dimafx-server/src/auth.rs:61`,
  `dimadb-server/src/js.rs:10,15,37,85,97`: already delegate to shared text functions.

dima-text has no public array-index classifier; qs retains the small membership adapter above.
No missing primitive blocks the replacements in this package. Distinct typed decoding, BSON class behavior,
encodeurl/RFC5987 and V8 diagnostic contracts intentionally remain local. Existing length units,
identity ordering, waits, timeouts and pacing are unchanged.

## Verification

- Fast-forwarded to rust-v2 `f6dd3785`; `14ab9454` is an ancestor.
- Each numbered item passed its affected crates' format/Clippy/test gates before its commit.
- Final required six-crate `tools/check`: 617 passed, zero failed; two existing ignored store
  documentation snippets (not runtime checks). Store tests ran with tools/test-env and required stores.
- One earlier combined run failed a dimadb process test at `start_rust(...).expect("starts")`,
  before sending malformed requests. The helper suppresses child stderr, so no startup cause was
  available. This test passed in the earlier dimadb gates and in the complete final rerun; no test
  or server-startup code was changed to make it pass.
- `tools/cargo check --workspace --all-targets`: passed.
- `tools/cargo build -p dima-rig -p dimadb-server`: passed.
- `target/debug/dima-rig verify dimadb`: 22/22 MATCH, including redis/scan; no scan difference observed.
- Local Node 26.13.0 (TZ=UTC for dates) independently confirmed negative-year date strings,
  shortest decimal numeric keys, the canonical-key predicate, and repeated-sign rejection.
- `git diff --check`: passed. Net production reduction: 241 lines (unit test modules excluded);
  gross Rust diff deletions: 370 lines. Regression tests added alongside the replacements.
- No blocking open questions. Equivalent candidates outside the owned paths and the private
  array-index predicate are listed above for their owners. Build/verification only; no deployment.
