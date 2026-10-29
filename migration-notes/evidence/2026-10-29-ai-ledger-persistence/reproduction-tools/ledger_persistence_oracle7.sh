set -eu
export TZ=UTC
wave=/artifacts/ledger-persistence/attempt7
export DIMA_AI_LOCK_REFERENCE_DIR=/artifacts/ledger-persistence/attempt2/lock
node tests/fixtures/ai_usage_lock_reference.cjs --check "$DIMA_AI_LOCK_REFERENCE_DIR"
node tests/fixtures/ai_usage_ledger_persistence_reference.cjs --write "$wave/persistence"
node tests/fixtures/ai_usage_ledger_persistence_reference.cjs --check "$wave/persistence"
