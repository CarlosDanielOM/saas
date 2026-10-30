set -eu
wave=/artifacts/ai-usage-retirement/attempt5
export TZ=UTC
export AI_USAGE_LOSSLESS_REFERENCE_DIR="$wave/lossless"
export AI_USAGE_LOSSLESS_REFERENCE_SHA256=9fc868d8ad5781fefe5d0dba7b7626f862ebc0112dd06b8338c0412db691be1a
export DIMA_AI_USAGE_PRODUCER_FIXTURE_DIR="$wave/producer"
export DIMA_AI_USAGE_PRODUCER_NAMESPACE=producer-fixture-abcdefgh:
export DIMA_AI_USAGE_RECEIPT_PARSER_FIXTURE_DIR="$wave/parser"
export DIMA_AI_RECEIPT_NODE_ROOT=/artifacts/posthog-receipt/attempt1/node-provenance/root
export DIMA_AI_RECEIPT_NODE_BINARY=/artifacts/posthog-receipt/attempt1/node-provenance/node
export POSTHOG_TRACKING_FIXTURES="$wave/tracking"
export DIMA_AI_LOCK_REFERENCE_DIR="$wave/lock"
export DIMA_AI_LEDGER_BACKFILL_REFERENCE_DIR=/artifacts/ai-usage-retirement/attempt6/backfill
export DIMA_AI_LEDGER_BACKFILL_NODE_BINARY=/artifacts/posthog-receipt/attempt1/node-provenance/node
export DIMA_AI_LEDGER_BACKFILL_NODE_DEPENDENCY_ROOT="$wave/backfill-provenance/root"
export DIMA_AI_LEDGER_PERSISTENCE_REFERENCE_DIR=/artifacts/ai-usage-retirement/attempt6/persistence
export DIMA_AI_LEDGER_PERSISTENCE_NODE_BINARY=/artifacts/posthog-receipt/attempt1/node-provenance/node
export DIMA_AI_LEDGER_PERSISTENCE_NODE_DEPENDENCY_ROOT="$wave/persistence-provenance/root"
export DIMA_AI_LEDGER_QUERIES_REFERENCE_DIR=/artifacts/ai-usage-retirement/attempt6/queries
export DIMA_AI_LEDGER_QUERIES_NODE_BINARY=/artifacts/posthog-receipt/attempt1/node-provenance/node
export DIMA_AI_LEDGER_QUERIES_NODE_DEPENDENCY_ROOT="$wave/queries-provenance/root"
features=ai-usage-ledger-backfill,ai-usage-ledger-queries,ai-usage-lossless,posthog-tracking
cargo fmt --all -- --check
cargo test --locked --no-default-features --features "$features" --test ai_usage_ledger_backfill --test ai_usage_ledger_persistence --test ai_usage_ledger_queries -- --nocapture --test-threads=1
cargo test --locked --no-default-features --features "$features" --test ai_usage_ledger_backfill complete_actual_source_replay -- --ignored --exact --nocapture
cargo test --locked --no-default-features --features "$features" --test ai_usage_ledger_persistence complete_actual_source_replay -- --ignored --exact --nocapture
cargo test --locked --no-default-features --features "$features" --test ai_usage_ledger_queries actual_source_complete_replay -- --ignored --exact --nocapture
cargo clippy --locked --no-default-features --all-targets -- -D warnings
cargo clippy --locked --all-features --all-targets -- -D warnings
