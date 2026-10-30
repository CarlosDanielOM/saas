# Moderation advanced value adapter handoff

The parser accepts a shared moderation-scoped `InputValue` over either
`JsonView` or a borrowed `lossless_json::JsonValue`. It reads last-key-wins own
properties, strings as UTF-16 `JsString`, booleans, binary64 numbers, objects,
and arrays without serialization or property getter execution. Native input
can carry NaN, both infinities, and negative zero, preserving source number
classification and negative-zero bits. Missing object fields represent
JavaScript `undefined`; the native tree does not model undefined array
elements, prototypes, accessors, symbols, functions, or BigInt.

`parse_advanced_rule`, `parse_advanced_rule_with`, and
`parse_advanced_rule_with_fallible_uuid` retain the `JsonView` input boundary.
Their owned counterparts are `parse_advanced_rule_owned`,
`parse_advanced_rule_owned_with`, and
`parse_advanced_rule_owned_with_fallible_uuid`. Both call the same parser in
source order: patterns, semantic policy, then blacklist restriction. The UUID
seam remains fallible and is called only at the source's invalid or missing ID
point. Errors expose public `name` and `message`, implement `Display` and
`std::error::Error`, and preserve actual root-null `TypeError` behavior with
`Cannot read properties of null (reading 'patterns')`. Other scalar and array
roots retain their missing-property behavior.

The existing `parse_semantic_policy` and `paid_moderation` view APIs remain
available; `parse_semantic_policy_owned` and `paid_moderation_owned` accept
native values. `empty_semantic_policy` and the semantic normalizer retain
their behavior. The value adapter is in `advanced_policy.rs` and needs no
parent module wiring.

The external fixture tests construct owned input directly from tagged UTF-16
and binary64 values, require all 464 cases, compare successful tagged values
recursively with exact number bits, check parser error name/message and UUID
draws, and exercise the view parser on all 233 representable parse inputs. The
focused semantic replay requires all 84 selected cases, including nonfinite
values, and cross-checks 83 representable inputs through the view. Both passed
under the isolated verification recorded in the
[integrated moderation evidence note](moderation-advanced.md). The source
fixture's independent SHA-256 and canonical external-path guard remain in
place.

One separate matcher limitation remains: the fixture's invalid-regex match
case expects a node-re2 `SyntaxError` and message, while the native matcher
exposes a compile failure without that source error class or message. The
replay confirms failure but does not establish exact matcher diagnostic
parity. The adapter does not change the regex engine. No full SDK API parity,
caller adoption, deployment, TypeScript retirement, or total migration
completion is implied.
