set -eu
export TZ=UTC
wave=/artifacts/ai-classification/attempt1
features=ai-usage-ledger-backfill,ai-usage-ledger-queries,ai-usage-retention
export DIMA_AI_USAGE_PRODUCER_FIXTURE_DIR="$wave/producer"
export DIMA_AI_USAGE_PRODUCER_NAMESPACE=producer-fixture-classify20261029a:
export DIMA_AI_USAGE_RECEIPT_PARSER_FIXTURE_DIR="$wave/parser"
export DIMA_AI_RECEIPT_NODE_ROOT=/source/dimabot
export DIMA_AI_RECEIPT_NODE_BINARY=/artifacts/posthog-receipt/attempt1/node-provenance/node
export DIMA_AI_LEDGER_QUERIES_REFERENCE_DIR="$wave/queries"
export DIMA_AI_LEDGER_QUERIES_NODE_BINARY="$DIMA_AI_RECEIPT_NODE_BINARY"
export DIMA_AI_LEDGER_QUERIES_NODE_DEPENDENCY_ROOT=/source/dimabot
export DIMA_AI_LEDGER_PERSISTENCE_REFERENCE_DIR="$wave/persistence"
export DIMA_AI_LEDGER_PERSISTENCE_NODE_BINARY="$DIMA_AI_RECEIPT_NODE_BINARY"
export DIMA_AI_LEDGER_PERSISTENCE_NODE_DEPENDENCY_ROOT=/source/dimabot
export DIMA_AI_LEDGER_BACKFILL_REFERENCE_DIR="$wave/backfill"
export DIMA_AI_LEDGER_BACKFILL_NODE_BINARY="$DIMA_AI_RECEIPT_NODE_BINARY"
export DIMA_AI_LEDGER_BACKFILL_NODE_DEPENDENCY_ROOT=/source/dimabot
export DIMA_AI_LOCK_REFERENCE_DIR=/artifacts/ledger-backfill/attempt2/lock
cargo test --locked --offline --no-default-features --features "$features" --test ai_usage_producer --test ai_usage_receipt_parser --test ai_usage_ledger_queries --test ai_usage_ledger_persistence --test ai_usage_ledger_backfill
cargo test --locked --offline --no-default-features --features "$features" --test ai_usage_producer replay_actual_source_fixture -- --ignored --exact
for zone in UTC America/New_York Europe/Berlin Australia/Lord_Howe Pacific/Apia; do
 TZ="$zone" cargo test --locked --offline --no-default-features --features "$features" --test ai_usage_receipt_parser replay_actual_source_parser_and_bson -- --ignored --exact
done
cargo test --locked --offline --no-default-features --features "$features" --test ai_usage_ledger_queries actual_source_complete_replay -- --ignored --exact
cargo test --locked --offline --no-default-features --features "$features" --test ai_usage_ledger_persistence complete_actual_source_replay -- --ignored --exact
cargo test --locked --offline --no-default-features --features "$features" --test ai_usage_ledger_backfill complete_actual_source_replay -- --ignored --exact
cargo check --locked --offline --no-default-features --all-targets
cargo check --locked --offline --no-default-features --features mongo,redis --all-targets
cargo check --locked --offline --all-features --all-targets
cargo clippy --locked --offline --all-features --all-targets -- -D warnings
