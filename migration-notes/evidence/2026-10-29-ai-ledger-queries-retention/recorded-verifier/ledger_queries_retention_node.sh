set -eu
export TZ=UTC
wave=/artifacts/ledger-query-retention/attempt2
mkdir -p "$wave/queries"
node tests/fixtures/ai_usage_ledger_queries_reference.cjs --write "$wave/queries"
node tests/fixtures/ai_usage_ledger_queries_reference.cjs --check "$wave/queries"
node /task-tools/copy_ledger_followup_node_provenance.cjs "$wave/queries/ai_usage_ledger_queries_reference.json" "$wave/queries-node-provenance"
mkdir -p "$wave/retention"
node tests/fixtures/ai_usage_retention_reference.cjs --write "$wave/retention"
node tests/fixtures/ai_usage_retention_reference.cjs --check "$wave/retention"
node /task-tools/copy_ledger_followup_node_provenance.cjs "$wave/retention/ai_usage_retention_reference.json" "$wave/retention-node-provenance"
