set -eu
. /task-tools/semantic_node_env1.sh
export DIMA_SEMANTIC_WORKER_READER_SHA256=3f5a6e657ae87622e62bc3ac0a1a771389176e868e4f8be5c7865312c7514ecb
export DIMA_BSON_SOURCE_ROOT=/source/dimabot
mkdir -p /artifacts/moderation-semantic-worker/attempt1/reference
mkdir -p /artifacts/moderation-semantic-worker/attempt1/bson-reference
mkdir -p /artifacts/bson-js-json/benchmark1
node --check tests/fixtures/moderation_semantic_worker_reference.cjs
node tests/fixtures/moderation_semantic_worker_reference.cjs --write /artifacts/moderation-semantic-worker/attempt1/reference
node tests/fixtures/moderation_semantic_worker_reference.cjs --check /artifacts/moderation-semantic-worker/attempt1/reference
node tests/fixtures/bson_js_json_reference.cjs --write /artifacts/moderation-semantic-worker/attempt1/bson-reference
node tests/fixtures/bson_js_json_reference.cjs --check /artifacts/moderation-semantic-worker/attempt1/bson-reference
node --check tests/fixtures/bson_js_json_benchmark.cjs
node tests/fixtures/bson_js_json_benchmark.cjs --write /artifacts/bson-js-json/benchmark1
