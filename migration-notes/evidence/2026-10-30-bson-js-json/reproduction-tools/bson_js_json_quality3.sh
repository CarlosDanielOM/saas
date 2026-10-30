set -eu
export DIMA_BSON_JSON_FIXTURE=/artifacts/bson-js-json/attempt3/reference/bson-js-json-reference.json
export DIMA_BSON_JSON_FIXTURE_SHA256=b609cc0af482b7cee004d13439f075bd0bd7b6848d00bd7901da7e0f97d569f4
cargo fmt --all -- --check
cargo test --locked --no-default-features --features bson-js-json --test bson_js_json -- --include-ignored --nocapture
cargo clippy --locked --no-default-features --features bson-js-json --all-targets -- -D warnings
cargo check --locked --no-default-features --all-targets
cargo clippy --locked --no-default-features --features mongo,redis --all-targets -- -D warnings
cargo clippy --locked --all-features --all-targets -- -D warnings
