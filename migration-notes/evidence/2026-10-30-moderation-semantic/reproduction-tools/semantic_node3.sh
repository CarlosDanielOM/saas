set -eu
. /task-tools/semantic_node_env1.sh
node --check tests/fixtures/moderation_semantic_source.cjs
node --check tests/fixtures/moderation_semantic_reference.cjs
node tests/fixtures/moderation_semantic_reference.cjs --write /artifacts/moderation-semantic/attempt3/reference
node tests/fixtures/moderation_semantic_reference.cjs --check /artifacts/moderation-semantic/attempt3/reference
