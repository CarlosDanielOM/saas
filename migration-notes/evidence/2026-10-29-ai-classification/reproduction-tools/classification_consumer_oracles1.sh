set -eu
export TZ=UTC
wave=/artifacts/ai-classification/attempt1
export DIMA_AI_USAGE_PRODUCER_NAMESPACE=producer-fixture-classify20261029a:
export DIMA_AI_LOCK_REFERENCE_DIR=/artifacts/ledger-backfill/attempt2/lock
node tests/fixtures/ai_usage_lock_reference.cjs --check "$DIMA_AI_LOCK_REFERENCE_DIR"
node tests/fixtures/ai_usage_producer_reference.cjs --write "$wave/producer"
node tests/fixtures/ai_usage_producer_reference.cjs --check "$wave/producer"
node tests/fixtures/ai_usage_receipt_parser_reference.cjs --write "$wave/parser"
node tests/fixtures/ai_usage_receipt_parser_reference.cjs --check "$wave/parser"
node tests/fixtures/ai_usage_ledger_queries_reference.cjs --write "$wave/queries"
node tests/fixtures/ai_usage_ledger_queries_reference.cjs --check "$wave/queries"
node tests/fixtures/ai_usage_ledger_persistence_reference.cjs --write "$wave/persistence"
node tests/fixtures/ai_usage_ledger_persistence_reference.cjs --check "$wave/persistence"
node tests/fixtures/ai_usage_ledger_backfill_reference.cjs --write "$wave/backfill"
node tests/fixtures/ai_usage_ledger_backfill_reference.cjs --check "$wave/backfill"
