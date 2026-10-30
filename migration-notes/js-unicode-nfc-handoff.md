# Unicode 17 NFC shared utility handoff

`js_unicode::normalize_nfc` provides a UTF-16-preserving `Cow<JsString>` API shared by moderation variations. ASCII and unchanged values borrow; changed values own their output. Lowercase and fold behavior is unchanged.

The source behavior is `String.prototype.normalize('NFC')` under pinned Node 24.22.1 / V8 13.6.233.17-node.58 / ICU 78.3 / Unicode 17. Native normalization uses pinned `unicode-normalization` 0.1.26 data but runs only over Unicode 17 assigned scalar spans; Unicode 17 unassigned scalars and lone surrogates are barriers. Valid UTF-8 uses the shared helper's guarded path, and UTF-16 fallback preserves lone surrogates.

The Node sweep checked all 1,114,112 code-point values, including 2,048 surrogate values, plus 4,116 sequences. It found 1,120 changed values and canonical digest `4340922e94668efdcf19b7a2d57519288402aefc26a84c511b0cd52266a999ca`. The final fixture SHA is `f8b8638a17f70d25e5fd46df06570387d16f28874da905455857079926458882`; the native full replay passed in final compiler phase `1793335018338289470`. Exact fixture and receipts are in [the evidence index](evidence/2026-10-30-moderation-variations/index.json).
