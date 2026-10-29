set -eu
export TZ=UTC
wave=/artifacts/ledger-persistence/attempt2
features=ai-usage-ledger-persistence,ai-usage-ledger-queries,ai-usage-retention
export DIMA_AI_USAGE_PRODUCER_FIXTURE_DIR="$wave/producer"
export DIMA_AI_USAGE_RECEIPT_PARSER_FIXTURE_DIR="$wave/parser"
export DIMA_AI_RECEIPT_NODE_ROOT=/artifacts/posthog-receipt/attempt1/node-provenance/root
export DIMA_AI_RECEIPT_NODE_BINARY=/artifacts/posthog-receipt/attempt1/node-provenance/node
export DIMA_AI_LEDGER_QUERIES_REFERENCE_DIR="$wave/queries"
export DIMA_AI_LEDGER_QUERIES_NODE_BINARY="$DIMA_AI_RECEIPT_NODE_BINARY"
export DIMA_AI_LEDGER_QUERIES_NODE_DEPENDENCY_ROOT="$wave/queries-node-provenance/root"
find "$wave/producer" "$wave/parser" "$wave/queries" -type f -exec sha256sum {} \; | sort > "$wave/category-replay-before.sha256"
cargo test --locked --offline --no-default-features --features "$features" --test ai_usage_producer replay_actual_source_fixture -- --ignored --exact --nocapture
for zone in UTC America/New_York Europe/Berlin Australia/Lord_Howe Pacific/Apia; do
 TZ="$zone" cargo test --locked --offline --no-default-features --features "$features" --test ai_usage_receipt_parser replay_actual_source_parser_and_bson -- --ignored --exact --nocapture
done
cargo test --locked --offline --no-default-features --features "$features" --test ai_usage_ledger_queries actual_source_complete_replay -- --ignored --exact --nocapture
find "$wave/producer" "$wave/parser" "$wave/queries" -type f -exec sha256sum {} \; | sort > "$wave/category-replay-after.sha256"
cmp "$wave/category-replay-before.sha256" "$wave/category-replay-after.sha256"
