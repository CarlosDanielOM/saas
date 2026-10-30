set -eu
. /task-tools/decision_store_node_env2.sh
node /task-tools/mongoose_package_guard.cjs
node --check tests/fixtures/moderation_decisions_source.cjs
node --check tests/fixtures/moderation_decisions_reference.cjs
node tests/fixtures/moderation_decisions_reference.cjs --write /artifacts/moderation-decisions/attempt2/reference
node tests/fixtures/moderation_decisions_reference.cjs --check /artifacts/moderation-decisions/attempt2/reference
node /task-tools/mongoose_package_guard.cjs
