set -eu
export TZ=UTC
wave=/artifacts/ai-usage-ledger-reads/attempt2
mkdir -p "$wave/reference"
node tests/fixtures/ai_usage_ledger_reads_reference.cjs --write "$wave/reference"
node tests/fixtures/ai_usage_ledger_reads_reference.cjs --check "$wave/reference"
node /task-tools/copy_ledger_reads_node_provenance.cjs "$wave/reference/ai_usage_ledger_reads_reference.json" "$wave/node-provenance"
