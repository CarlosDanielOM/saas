set -eu
export TZ=UTC
mkdir -p /artifacts/ledger-query-retention/attempt3/queries
node tests/fixtures/ai_usage_ledger_queries_reference.cjs --write /artifacts/ledger-query-retention/attempt3/queries
node tests/fixtures/ai_usage_ledger_queries_reference.cjs --check /artifacts/ledger-query-retention/attempt3/queries
node tests/fixtures/ai_usage_retention_reference.cjs --check /artifacts/ledger-query-retention/attempt2/retention
