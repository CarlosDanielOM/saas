set -eu
export TZ=UTC
wave=/artifacts/ledger-persistence/attempt1
export DIMA_AI_USAGE_PRODUCER_NAMESPACE=producer-fixture-ledgerpersist20261029:
node tests/fixtures/ai_usage_producer_reference.cjs --write "$wave/producer"
node tests/fixtures/ai_usage_producer_reference.cjs --check "$wave/producer"
node tests/fixtures/ai_usage_receipt_parser_reference.cjs --write "$wave/parser"
node tests/fixtures/ai_usage_receipt_parser_reference.cjs --check "$wave/parser"
node tests/fixtures/ai_usage_ledger_queries_reference.cjs --write "$wave/queries"
node tests/fixtures/ai_usage_ledger_queries_reference.cjs --check "$wave/queries"
node /task-tools/copy_ledger_followup_node_provenance.cjs "$wave/queries/ai_usage_ledger_queries_reference.json" "$wave/queries-node-provenance"
node tests/fixtures/ai_usage_retention_reference.cjs --write "$wave/retention"
node tests/fixtures/ai_usage_retention_reference.cjs --check "$wave/retention"
node /task-tools/copy_ledger_followup_node_provenance.cjs "$wave/retention/ai_usage_retention_reference.json" "$wave/retention-node-provenance"
