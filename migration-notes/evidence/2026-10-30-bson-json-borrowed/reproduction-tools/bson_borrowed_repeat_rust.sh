set -eu
export DIMA_BSON_JSON_BENCHMARK_DIR=/artifacts/bson-js-json/benchmark3
export DIMA_BSON_JSON_BENCHMARK_INPUT_SHA256=b719d74652c2104c1a2126b4757d70d3f5df094ba34ac07595bca01871dae89c
cargo test --release --locked --no-default-features --features bson-js-json --test bson_js_json_benchmark matched_prepared_bson_json -- --ignored --exact --nocapture
sha256sum /artifacts/bson-js-json/benchmark3/bson-js-json-input.json
