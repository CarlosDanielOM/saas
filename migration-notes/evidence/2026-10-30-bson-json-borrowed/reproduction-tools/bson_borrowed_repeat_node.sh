set -eu
export DIMA_BSON_SOURCE_ROOT=/source/dimabot
mkdir -p /artifacts/bson-js-json/benchmark3
node tests/fixtures/bson_js_json_benchmark.cjs --write /artifacts/bson-js-json/benchmark3
