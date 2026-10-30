set -eu
. /task-tools/spam_node_env2.sh
mkdir -p /artifacts/moderation-spam/attempt2/reference
node --check tests/fixtures/moderation_spam_source.cjs
node --check tests/fixtures/moderation_spam_reference.cjs
node --check tests/fixtures/moderation_spam_benchmark.cjs
node tests/fixtures/moderation_spam_reference.cjs --write /artifacts/moderation-spam/attempt2/reference
node tests/fixtures/moderation_spam_reference.cjs --check /artifacts/moderation-spam/attempt2/reference
