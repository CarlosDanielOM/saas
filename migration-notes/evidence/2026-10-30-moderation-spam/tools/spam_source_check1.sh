set -eu
. /task-tools/spam_node_env3.sh
node tests/fixtures/moderation_spam_reference.cjs --check /artifacts/moderation-spam/attempt3/reference
node tests/fixtures/moderation_spam_benchmark.cjs --check /artifacts/moderation-spam/benchmark-attempt1
