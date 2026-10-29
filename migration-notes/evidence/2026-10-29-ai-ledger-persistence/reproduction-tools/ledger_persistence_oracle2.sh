set -eu
export TZ=UTC
wave=/artifacts/ledger-persistence/attempt2
export DIMA_AI_LOCK_REFERENCE_DIR="$wave/lock"
node tests/fixtures/ai_usage_lock_reference.cjs --check "$wave/lock"
node tests/fixtures/ai_usage_ledger_persistence_reference.cjs --write "$wave/persistence"
node tests/fixtures/ai_usage_ledger_persistence_reference.cjs --check "$wave/persistence"
node /task-tools/copy_ledger_followup_node_provenance.cjs "$wave/persistence/ai_usage_ledger_persistence_reference.json" "$wave/persistence-node-provenance"
