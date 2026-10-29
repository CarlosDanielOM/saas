set -eu
export TZ=UTC
wave=/artifacts/ledger-query-retention/attempt2
export DIMA_AI_LEDGER_QUERIES_REFERENCE_DIR="$wave/queries"
export DIMA_AI_LEDGER_QUERIES_NODE_BINARY=/artifacts/posthog-receipt/attempt1/node-provenance/node
export DIMA_AI_LEDGER_QUERIES_NODE_DEPENDENCY_ROOT="$wave/queries-node-provenance/root"
export DIMA_RUST_TEST_RESOURCE_OWNER=dimabot-migration
export DIMA_TEST_MONGO_URI=mongodb://ai-ledger-queries-mongo-fixture:27017
export DIMA_AI_LEDGER_QUERIES_RESOURCE_TOKEN=queriesnative20261029a
export DIMA_AI_LEDGER_QUERIES_TEST_DATABASE=ai_ledger_queries_test_queriesnative20261029a
find "$wave/queries" "$wave/queries-node-provenance" -type f -exec sha256sum {} \; | sort > "$wave/queries-runtime-before.sha256"
cargo test --locked --offline --no-default-features --features ai-usage-ledger-queries --test ai_usage_ledger_queries actual_source_complete_replay -- --ignored --exact --nocapture
cargo test --locked --offline --no-default-features --features ai-usage-ledger-queries --test ai_usage_ledger_queries private_mongo_adapters_data_pool_errors_and_cancellation -- --ignored --exact --nocapture
find "$wave/queries" "$wave/queries-node-provenance" -type f -exec sha256sum {} \; | sort > "$wave/queries-runtime-after.sha256"
cmp "$wave/queries-runtime-before.sha256" "$wave/queries-runtime-after.sha256"
