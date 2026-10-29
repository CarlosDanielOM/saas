set -eu
export TZ=UTC
wave=/artifacts/ledger-query-retention/attempt2
export DIMA_RUST_TEST_RESOURCE_OWNER=dimabot-migration
export DIMA_TEST_MONGO_URI=mongodb://ai-usage-retention-mongo-fixture:27017
export DIMA_AI_USAGE_RETENTION_RESOURCE_TOKEN=retentionwirenative20261029a
export DIMA_AI_USAGE_RETENTION_TEST_DATABASE=ai_usage_retention_test_retentionwirenative20261029a
export DIMA_AI_USAGE_RETENTION_ORACLE="$wave/retention/ai_usage_retention_reference.json"
export DIMA_AI_USAGE_RETENTION_NODE_BINARY=/artifacts/posthog-receipt/attempt1/node-provenance/node
export DIMA_AI_USAGE_RETENTION_NODE_DEPENDENCY_ROOT="$wave/retention-node-provenance/root"
find "$wave/retention" "$wave/retention-node-provenance" -type f -exec sha256sum {} \; | sort > "$wave/retention-replay-before.sha256"
cargo test --locked --offline --no-default-features --features ai-usage-retention --test ai_usage_retention actual_source_wire_replay -- --ignored --exact --nocapture
find "$wave/retention" "$wave/retention-node-provenance" -type f -exec sha256sum {} \; | sort > "$wave/retention-replay-after.sha256"
cmp "$wave/retention-replay-before.sha256" "$wave/retention-replay-after.sha256"
