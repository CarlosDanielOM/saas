set -eu
export DIMA_SEMANTIC_WORKER_REFERENCE=/artifacts/moderation-semantic-worker/attempt1/reference/moderation-semantic-worker-reference.json
export DIMA_SEMANTIC_WORKER_REFERENCE_SHA256=bb23cdda5a0c412c6707556e8bd53758882aac6e3f306aafd8b164fdc9288bd8
export DIMA_BSON_JSON_FIXTURE=/artifacts/moderation-semantic-worker/attempt1/bson-reference/bson-js-json-reference.json
export DIMA_BSON_JSON_FIXTURE_SHA256=13f2bb85426b09f2367881e0cee3902cf08f4490ea39c0ce3ce80a1c0e41a4be
export DIMA_VARIATION_JOBS_FAILPOINT_OWNER="$KEYWORD_FIXTURE_NAMESPACE"
cargo fmt --all -- --check
cargo check --locked --no-default-features --features moderation-semantic-worker --tests
cargo test --locked --no-default-features --features moderation-semantic-worker --test moderation_semantic_worker -- --include-ignored --nocapture --test-threads=1
cargo test --locked --no-default-features --features bson-js-json --test bson_js_json -- --include-ignored --nocapture
cargo clippy --locked --no-default-features --features moderation-semantic-worker --all-targets -- -D warnings
cargo check --locked --no-default-features --all-targets
cargo clippy --locked --no-default-features --features mongo,redis --all-targets -- -D warnings
cargo clippy --locked --all-features --all-targets -- -D warnings
