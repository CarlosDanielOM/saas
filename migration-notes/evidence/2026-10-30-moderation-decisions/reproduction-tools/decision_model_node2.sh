set -eu
export DIMA_SCHEMA_SOURCE_ROOT=/source/dimabot
export DIMA_SCHEMA_NODE_SHA256=569128f3066ac7be59b10b9a0adef708def642ee37cbf9d560a9bdb68f872108
export TZ=UTC
node /task-tools/mongoose_package_guard.cjs
node --check tests/fixtures/moderation_decision_schema_reference.cjs
node --check tests/fixtures/mongoose_set_on_insert_reference.cjs
node tests/fixtures/moderation_decision_schema_reference.cjs --write /artifacts/moderation-decision-model/attempt2/schema
node tests/fixtures/moderation_decision_schema_reference.cjs --check /artifacts/moderation-decision-model/attempt2/schema
node tests/fixtures/mongoose_set_on_insert_reference.cjs --write /artifacts/moderation-decision-model/attempt2/insert
node tests/fixtures/mongoose_set_on_insert_reference.cjs --check /artifacts/moderation-decision-model/attempt2/insert
node /task-tools/mongoose_package_guard.cjs
