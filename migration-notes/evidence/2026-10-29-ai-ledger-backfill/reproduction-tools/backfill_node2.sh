set -eu
export TZ=UTC
wave=/artifacts/ledger-backfill/attempt2
export DIMA_AI_LOCK_REFERENCE_DIR="$wave/lock"
node tests/fixtures/ai_usage_lock_reference.cjs --write "$wave/lock"
node tests/fixtures/ai_usage_lock_reference.cjs --check "$wave/lock"
node tests/fixtures/ai_usage_ledger_backfill_reference.cjs --write "$wave/reference"
node tests/fixtures/ai_usage_ledger_backfill_reference.cjs --check "$wave/reference"
