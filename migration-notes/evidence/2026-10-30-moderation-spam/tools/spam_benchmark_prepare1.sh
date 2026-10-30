set -eu
. /task-tools/spam_node_env3.sh
mkdir -p /artifacts/moderation-spam/benchmark-attempt1
node tests/fixtures/moderation_spam_benchmark.cjs --write /artifacts/moderation-spam/benchmark-attempt1
node tests/fixtures/moderation_spam_benchmark.cjs --check /artifacts/moderation-spam/benchmark-attempt1
