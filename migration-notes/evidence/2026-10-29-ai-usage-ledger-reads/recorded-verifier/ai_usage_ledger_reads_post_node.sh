set -eu
export TZ=UTC
node tests/fixtures/ai_usage_ledger_reads_reference.cjs --check /artifacts/ai-usage-ledger-reads/attempt2/reference
