set -eu
export DIMA_BSON_SOURCE_ROOT=/source/dimabot
mkdir -p /artifacts/bson-js-json/borrowed-attempt1/reference
mkdir -p /artifacts/bson-js-json/benchmark2
node tests/fixtures/bson_js_json_reference.cjs --write /artifacts/bson-js-json/borrowed-attempt1/reference
node tests/fixtures/bson_js_json_reference.cjs --check /artifacts/bson-js-json/borrowed-attempt1/reference
node tests/fixtures/bson_js_json_benchmark.cjs --write /artifacts/bson-js-json/benchmark2
