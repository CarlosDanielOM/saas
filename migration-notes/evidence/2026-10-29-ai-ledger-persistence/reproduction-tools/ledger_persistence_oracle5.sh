set -eu
export TZ=UTC
wave=/artifacts/ledger-persistence/attempt5
mkdir -p "$wave/persistence" "$wave/queries" "$wave/retention" "$wave/negative-clock"
export DIMA_AI_LOCK_REFERENCE_DIR=/artifacts/ledger-persistence/attempt2/lock
node tests/fixtures/ai_usage_lock_reference.cjs --check "$DIMA_AI_LOCK_REFERENCE_DIR"
node /task-tools/persistence_clock_negative.cjs "$wave/negative-clock"
node tests/fixtures/ai_usage_ledger_persistence_reference.cjs --write "$wave/persistence"
node tests/fixtures/ai_usage_ledger_persistence_reference.cjs --check "$wave/persistence"
node tests/fixtures/ai_usage_ledger_queries_reference.cjs --write "$wave/queries"
node tests/fixtures/ai_usage_ledger_queries_reference.cjs --check "$wave/queries"
node tests/fixtures/ai_usage_retention_reference.cjs --write "$wave/retention"
node tests/fixtures/ai_usage_retention_reference.cjs --check "$wave/retention"
