# Unicode replay test handoff

Copy `tests/js_regexp_unicode.rs` into the crate's `tests/` directory alongside the existing `tests/support/sha256.rs`. It assumes the public `js-regexp-unicode` feature and the requested API. The ignored replay consumes an externally produced, independently SHA-256-pinned fixture and checks its declared source hashes and generated data hash against the source snapshot. The fixture generator's boundary-closure check is evidence about the reference; this replay does not implement or test a complete JavaScript regular expression engine.

Static authoring only: no compiler, formatter, tests, Node, containers, or network were run. The test has not been compiled or executed, and its compatibility with the final fixture generator, source manifest and implementation requires integration verification. The fixture must be supplied separately with `DIMA_JS_REGEXP_UNICODE_FIXTURE_DIR` and an independently obtained `DIMA_JS_REGEXP_UNICODE_FIXTURE_SHA256`.
