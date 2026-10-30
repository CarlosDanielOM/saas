set -eu
export DIMA_BSON_JSON_BENCHMARK_DIR=/artifacts/bson-js-json/benchmark1
export DIMA_BSON_JSON_BENCHMARK_INPUT_SHA256=65c16f8fbd2545584bef7c8a23a684e890bc465e7c23872b7c72310e06cf38f5
cargo test --release --locked --no-default-features --features bson-js-json --test bson_js_json_benchmark matched_prepared_bson_json -- --ignored --exact --nocapture
sha256sum /artifacts/bson-js-json/benchmark1/bson-js-json-input.json
