set -eu
export TZ=UTC
wave=/artifacts/ledger-persistence/attempt7
export DIMA_AI_LEDGER_PERSISTENCE_REFERENCE_DIR="$wave/persistence"
export DIMA_AI_LOCK_REFERENCE_DIR=/artifacts/ledger-persistence/attempt2/lock
export DIMA_AI_LEDGER_PERSISTENCE_NODE_BINARY=/artifacts/posthog-receipt/attempt1/node-provenance/node
export DIMA_AI_LEDGER_PERSISTENCE_NODE_DEPENDENCY_ROOT=/artifacts/ledger-persistence/attempt2/persistence-node-provenance/root
export DIMA_RUST_TEST_RESOURCE_OWNER=dimabot-migration
export DIMA_TEST_MONGO_URI=mongodb://ai-ledger-persistence-mongo-fixture:27017
export DIMA_TEST_REDIS_URI=redis://ai-ledger-persistence-redis-fixture:6379/
export DIMA_AI_LEDGER_PERSISTENCE_RESOURCE_TOKEN=persistnative20261029g
export DIMA_AI_LEDGER_PERSISTENCE_TEST_DATABASE=ai_ledger_persistence_test_persistnative20261029g
find "$wave/persistence" "$DIMA_AI_LOCK_REFERENCE_DIR" /artifacts/ledger-persistence/attempt2/persistence-node-provenance -type f -exec sha256sum {} \; | sort > "$wave/persistence-runtime-before.sha256"
cargo test --locked --offline --no-default-features --features ai-usage-ledger-persistence,ai-usage-ledger-queries,ai-usage-retention --test ai_usage_ledger_persistence complete_actual_source_replay -- --ignored --exact --nocapture
cargo test --locked --offline --no-default-features --features ai-usage-ledger-persistence,ai-usage-ledger-queries,ai-usage-retention --test ai_usage_ledger_persistence private_mongo_and_real_redis_persistence_protocol -- --ignored --exact --nocapture
find "$wave/persistence" "$DIMA_AI_LOCK_REFERENCE_DIR" /artifacts/ledger-persistence/attempt2/persistence-node-provenance -type f -exec sha256sum {} \; | sort > "$wave/persistence-runtime-after.sha256"
cmp "$wave/persistence-runtime-before.sha256" "$wave/persistence-runtime-after.sha256"

export DIMA_AI_LEDGER_QUERIES_REFERENCE_DIR=/artifacts/ledger-persistence/attempt5/queries
export DIMA_AI_LEDGER_QUERIES_NODE_BINARY="$DIMA_AI_LEDGER_PERSISTENCE_NODE_BINARY"
export DIMA_AI_LEDGER_QUERIES_NODE_DEPENDENCY_ROOT=/artifacts/ledger-persistence/attempt2/queries-node-provenance/root
cargo test --locked --offline --no-default-features --features ai-usage-ledger-persistence,ai-usage-ledger-queries,ai-usage-retention --test ai_usage_ledger_queries actual_source_complete_replay -- --ignored --exact --nocapture
