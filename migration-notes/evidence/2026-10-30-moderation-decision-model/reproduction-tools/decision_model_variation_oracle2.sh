set -eu
node /task-tools/mongoose_package_guard.cjs
export DIMA_SCHEMA_NODE_SHA256=569128f3066ac7be59b10b9a0adef708def642ee37cbf9d560a9bdb68f872108
export DIMA_SCHEMA_SOURCE_ROOT=/source/dimabot
mkdir -p /artifacts/moderation-decision-model/attempt2/variation-schema
node tests/fixtures/moderation_variation_schema_reference.cjs --write /artifacts/moderation-decision-model/attempt2/variation-schema
node tests/fixtures/moderation_variation_schema_reference.cjs --check /artifacts/moderation-decision-model/attempt2/variation-schema
node /task-tools/mongoose_package_guard.cjs
