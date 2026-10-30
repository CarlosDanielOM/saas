# BSON JavaScript JSON projection — 2026-10-30

## Scope and verified result

Commit `67fcccb8889cfd8f58d7f54b5bdaa92f200f4e74` adds the feature-gated shared helper `dima_rust::utils::bson_js_json::bson_js_json(&Bson) -> Result<JsonValue, BsonJsJsonError>`. It projects the JSON-visible result of the default Node MongoDB BSON reader for use with the existing lossless JSON serializer. This is a BSON **decode projection**, not a storage conversion: keep the original BSON value for database writes.

The final pinned Node oracle run `node-1793353128382905292` and capped compiler run `compiler-1793353141707940216` used the same frozen source tree, SHA-256 `a0cc07bb6978725aa1a292d46c15e27c1fdfb9b69d5ce4edd50f8f90b56d2a70`. Their 1,459 bound inputs comprise 1,449 Git inputs plus ten SDK source files reused from the prior archive-verified binding. The final fixture has 54 records and SHA-256 `b609cc0af482b7cee004d13439f075bd0bd7b6848d00bd7901da7e0f97d569f4`.

The final replay passed four ordinary Rust tests and one ignored pinned-reader replay. It covered 48 successful wire records, five `DBRef` copy-assignment cases that matched Node's inherited-readonly `TypeError`, and one invalid-RegExp case explicitly classified as a decoder boundary. Formatting, focused replay, scoped all-target Clippy, minimal all-target check, Mongo/Redis all-target Clippy, and all-feature all-target Clippy passed. The compiler step took 115.127 seconds; the full compiler phase took 124.703 seconds. Verified limits were six CPUs, 4 GiB memory with swap disabled, 256 PIDs, and two Cargo jobs; minimum available memory was 9,329,803,264 bytes and peak private cache use was 7,925,870,592 bytes.

The helper reuses existing `JsDate`, `JsString`, and `JsonValue` behavior. Its opt-in `bson-js-json` feature enables `mongo`, `tts-utilities`, `credit-policy`, and the already declared optional `base64` and `sha2` dependencies. No new crate or worker was added. This library helper alone does not establish caller adoption, TypeScript retirement, deployment, or total migration completion.

## Projection behavior

With the default driver options, the reader promotes values into JavaScript BSON classes and primitives before `JSON.stringify`. The adapter models the observed JSON projection, including small and large `Long` behavior, dates and TimeClip, ObjectIds, binary and UUID, Decimal128 Extended JSON form, timestamps, code and scoped code, ordinary RegExp, DBRef recognition and `toJSON` ordering, Symbol promotion, and undefined omission/null behavior. It delegates string escaping, key ordering, and number serialization to the existing JSON implementation.

DBRef projection includes the source `Object.assign` copy behavior that matters for own `__proto__` and inherited class properties. The fixture verified five ordering-sensitive assignments rejected by SDK read-only accessors, including properties inherited from Long, Timestamp, RegExp, and other BSON values. These errors are represented as explicit projection errors at the adapter boundary.

## Limits and unresolved parity

- **Reader-stage RegExp validation:** Node constructs a JavaScript `RegExp` while decoding BSON. One invalid pattern is rejected by the SDK with `SyntaxError`, while the Rust BSON reader accepts the wire value. The fixture records it as `regex-invalid-reader`, outside the adapter's input domain. This is an explicit decoder boundary, not a matched native reader failure. Invalid RegExp nested under an omitted property and other eager nested decode failures are also not established by this projection.
- **Input bytes and representation:** Rust `Document` may collapse duplicate keys and normalize array keys before the helper runs. Native BSON UTF-8 decoding cannot preserve malformed UTF-8 or lone JavaScript UTF-16 surrogates. The 54-record fixture establishes only its representable cases; it is not generic malformed-BSON or duplicate-key reader parity.
- **Value and recursion limits:** The checked corpus does not establish every Decimal128 spelling/special value or arbitrary malformed BSON. Node and Rust readers may impose different recursion/depth limits. Projection and serialization add no artificial depth limit, so resource use for deeply nested attacker-controlled documents remains an integration concern.
- **Call-site errors:** Callers must handle the helper's `Result` where source code handles BSON reader or stringify failure. A standalone shared helper does not port application-specific error handling or prove a consumer uses it.

No performance result is claimed. A BSON projection benchmark was authored later, is absent from the frozen final source inputs, and was not executed. Production readback found all 18 tracked production records unchanged and no remaining task-owned containers, networks, or volumes. No deployment or push occurred.

See the [indexed evidence package](evidence/2026-10-30-bson-js-json/README.md) for the frozen source subset, SDK binding, oracle fixture, receipts, compressed logs, and reproduction tools. The [handoff](bson-js-json-handoff.md) records the concrete integration contract and evidence boundaries.
