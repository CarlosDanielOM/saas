set -eu
export TZ=UTC
export DIMA_AI_LOCK_REFERENCE_DIR=/artifacts/ledger-persistence/attempt2/lock
export DIMA_AI_USAGE_PRODUCER_NAMESPACE=producer-fixture-ledgerpersist20261029:
node tests/fixtures/ai_usage_lock_reference.cjs --check "$DIMA_AI_LOCK_REFERENCE_DIR"
node tests/fixtures/ai_usage_ledger_persistence_reference.cjs --check /artifacts/ledger-persistence/attempt7/persistence
node tests/fixtures/ai_usage_ledger_queries_reference.cjs --check /artifacts/ledger-persistence/attempt5/queries
node tests/fixtures/ai_usage_retention_reference.cjs --check /artifacts/ledger-persistence/attempt5/retention
node tests/fixtures/ai_usage_producer_reference.cjs --check /artifacts/ledger-persistence/attempt2/producer
node tests/fixtures/ai_usage_receipt_parser_reference.cjs --check /artifacts/ledger-persistence/attempt2/parser
mkdir /artifacts/ledger-persistence/attempt7/negative-clock
node /task-tools/persistence_clock_negative.cjs /artifacts/ledger-persistence/attempt7/negative-clock
