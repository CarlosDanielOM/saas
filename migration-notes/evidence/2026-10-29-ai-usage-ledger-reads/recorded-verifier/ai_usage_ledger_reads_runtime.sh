set -eu
export TZ=UTC
wave=/artifacts/ai-usage-ledger-reads/attempt2
export DIMA_AI_LEDGER_READS_REFERENCE_DIR="$wave/reference"
export DIMA_AI_LEDGER_READS_NODE_BINARY=/artifacts/posthog-receipt/attempt1/node-provenance/node
export DIMA_AI_LEDGER_READS_NODE_DEPENDENCY_ROOT="$wave/node-provenance/root"
export DIMA_RUST_TEST_RESOURCE_OWNER=dimabot-migration
export DIMA_TEST_MONGO_URI=mongodb://ai-ledger-reads-mongo-fixture:27017
export DIMA_AI_LEDGER_READS_RESOURCE_TOKEN=readsnative20261029a
export DIMA_AI_LEDGER_READS_TEST_DATABASE=ai_ledger_reads_test_readsnative20261029a
find "$wave/reference" "$wave/node-provenance" -type f -exec sha256sum {} \; | sort > "$wave/runtime-before.sha256"
cargo test --locked --offline --no-default-features --features ai-usage-ledger-reads --test ai_usage_ledger_reads actual_source_replay -- --ignored --exact --nocapture
cargo test --locked --offline --no-default-features --features ai-usage-ledger-reads --test ai_usage_ledger_reads private_mongo_adapter_behavior_pooling_errors_and_cancellation -- --ignored --exact --nocapture
find "$wave/reference" "$wave/node-provenance" -type f -exec sha256sum {} \; | sort > "$wave/runtime-after.sha256"
cmp "$wave/runtime-before.sha256" "$wave/runtime-after.sha256"
