set -eu
export DIMA_SCHEMA_NODE_SHA256=569128f3066ac7be59b10b9a0adef708def642ee37cbf9d560a9bdb68f872108
export DIMA_SCHEMA_SOURCE_ROOT=/source/dimabot
mkdir -p /artifacts/moderation-variation-schema/attempt2/reference
node tests/fixtures/moderation_variation_schema_reference.cjs --write /artifacts/moderation-variation-schema/attempt2/reference
node tests/fixtures/moderation_variation_schema_reference.cjs --check /artifacts/moderation-variation-schema/attempt2/reference
