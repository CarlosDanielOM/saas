set -eu
export TZ=UTC
export DIMA_AI_LEDGER_QUERIES_REFERENCE_DIR=/artifacts/ledger-query-retention/attempt3/queries
export DIMA_AI_LEDGER_QUERIES_NODE_BINARY=/artifacts/posthog-receipt/attempt1/node-provenance/node
export DIMA_AI_LEDGER_QUERIES_NODE_DEPENDENCY_ROOT=/artifacts/ledger-query-retention/attempt2/queries-node-provenance/root
cargo test --release --locked --offline --no-default-features --features ai-usage-ledger-queries,ai-usage-retention --test ai_usage_ledger_queries -- --nocapture
cargo test --release --locked --offline --no-default-features --features ai-usage-ledger-queries,ai-usage-retention --test ai_usage_ledger_queries actual_source_complete_replay -- --ignored --exact --nocapture
