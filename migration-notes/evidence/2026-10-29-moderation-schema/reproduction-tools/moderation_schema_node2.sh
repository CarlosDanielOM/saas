set -eu
export DIMA_SCHEMA_SOURCE_ROOT=/source/dimabot
export DIMA_SCHEMA_NODE_SHA256=569128f3066ac7be59b10b9a0adef708def642ee37cbf9d560a9bdb68f872108
export DIMA_MODERATION_SCHEMA_SOURCE_ROOT=/source/dimabot
export DIMA_MODERATION_SCHEMA_NODE_SHA256=$DIMA_SCHEMA_NODE_SHA256
node tests/fixtures/schema_composite_defaults_reference.cjs --write /artifacts/moderation-schema/attempt2/core-reference
node tests/fixtures/schema_composite_defaults_reference.cjs --check /artifacts/moderation-schema/attempt2/core-reference
node tests/fixtures/channel_moderation_settings_reference.cjs --write /artifacts/moderation-schema/attempt2/model-reference
node tests/fixtures/channel_moderation_settings_reference.cjs --check /artifacts/moderation-schema/attempt2/model-reference
