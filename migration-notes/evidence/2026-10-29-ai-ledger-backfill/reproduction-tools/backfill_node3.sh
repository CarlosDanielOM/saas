set -eu
export TZ=UTC
export DIMA_AI_LOCK_REFERENCE_DIR=/artifacts/ledger-backfill/attempt2/lock
node tests/fixtures/ai_usage_ledger_backfill_reference.cjs --write /artifacts/ledger-backfill/attempt3/reference
node tests/fixtures/ai_usage_ledger_backfill_reference.cjs --check /artifacts/ledger-backfill/attempt3/reference
