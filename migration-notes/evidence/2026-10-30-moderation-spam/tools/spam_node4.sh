set -eu
. /task-tools/spam_node_env4.sh
node --check /task-tools/matched_paired_coordinator.cjs
node tests/fixtures/moderation_spam_reference.cjs --write /artifacts/moderation-spam/attempt4/reference
node tests/fixtures/moderation_spam_reference.cjs --check /artifacts/moderation-spam/attempt4/reference
node tests/fixtures/moderation_spam_benchmark.cjs --check /artifacts/moderation-spam/benchmark-attempt1
