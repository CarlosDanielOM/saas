set -eu
export DIMA_BSON_SOURCE_ROOT=/source/dimabot
node tests/fixtures/bson_js_json_reference.cjs --check /artifacts/bson-js-json/borrowed-attempt1/reference
node tests/fixtures/bson_js_json_benchmark.cjs --check /artifacts/bson-js-json/benchmark2
node tests/fixtures/bson_js_json_benchmark.cjs --check /artifacts/bson-js-json/benchmark3
