set -eu
export DIMA_BSON_JSON_FIXTURE=/artifacts/bson-js-json/borrowed-attempt1/reference/bson-js-json-reference.json
export DIMA_BSON_JSON_FIXTURE_SHA256=b7a88bd77c3d2f78cd4787962d32e7b1264f9ccd06ccca66c6f3410ad74e5aac
export DIMA_BSON_JSON_BENCHMARK_DIR=/artifacts/bson-js-json/benchmark2
export DIMA_BSON_JSON_BENCHMARK_INPUT_SHA256=b719d74652c2104c1a2126b4757d70d3f5df094ba34ac07595bca01871dae89c
cargo fmt --all -- --check
cargo test --locked --no-default-features --features bson-js-json --test bson_js_json -- --include-ignored --nocapture
cargo clippy --locked --no-default-features --features bson-js-json --all-targets -- -D warnings
cargo test --release --locked --no-default-features --features bson-js-json --test bson_js_json_benchmark matched_prepared_bson_json -- --ignored --exact --nocapture
sha256sum /artifacts/bson-js-json/benchmark2/bson-js-json-input.json
cargo check --locked --no-default-features --all-targets
cargo clippy --locked --no-default-features --features mongo,redis --all-targets -- -D warnings
cargo clippy --locked --all-features --all-targets -- -D warnings
