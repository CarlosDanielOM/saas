set -eu
export DIMA_BSON_SOURCE_ROOT=/source/dimabot
mkdir -p /artifacts/bson-js-json/attempt2/reference
node --check tests/fixtures/bson_js_json_reference.cjs
node tests/fixtures/bson_js_json_reference.cjs --write /artifacts/bson-js-json/attempt2/reference
node tests/fixtures/bson_js_json_reference.cjs --check /artifacts/bson-js-json/attempt2/reference
sha256sum /artifacts/bson-js-json/attempt2/reference/bson-js-json-reference.json
