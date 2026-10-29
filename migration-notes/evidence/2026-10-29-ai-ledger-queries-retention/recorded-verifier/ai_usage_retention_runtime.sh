set -eu
export TZ=UTC
wave=/artifacts/ledger-query-retention/attempt2
export DIMA_RUST_TEST_RESOURCE_OWNER=dimabot-migration
export DIMA_TEST_MONGO_URI=mongodb://ai-usage-retention-mongo-fixture:27017
export DIMA_AI_USAGE_RETENTION_RESOURCE_TOKEN=retentionnative20261029a
export DIMA_AI_USAGE_RETENTION_TEST_DATABASE=ai_usage_retention_test_retentionnative20261029a
cargo test --locked --offline --no-default-features --features ai-usage-ledger-queries,ai-usage-retention --test ai_usage_retention private_mongo_mutations_and_partial_failures -- --ignored --exact --nocapture
