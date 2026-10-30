set -eu
export DIMA_BSON_JSON_FIXTURE=/artifacts/bson-js-json/attempt2/reference/bson-js-json-reference.json
export DIMA_BSON_JSON_FIXTURE_SHA256=816b7b9ffa08e338898217081e176fdff410a94a2f796bec69437816ce94b5aa
cargo fmt --all -- --check
cargo test --locked --no-default-features --features bson-js-json --test bson_js_json -- --include-ignored --nocapture
cargo clippy --locked --no-default-features --features bson-js-json --all-targets -- -D warnings
cargo check --locked --no-default-features --all-targets
cargo clippy --locked --no-default-features --features mongo,redis --all-targets -- -D warnings
cargo clippy --locked --all-features --all-targets -- -D warnings
