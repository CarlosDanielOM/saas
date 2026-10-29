set -eu
export TZ=UTC
wave=/artifacts/ledger-backfill/attempt4
export DIMA_AI_LEDGER_BACKFILL_REFERENCE_DIR="$wave/reference"
export DIMA_AI_LOCK_REFERENCE_DIR=/artifacts/ledger-backfill/attempt2/lock
export DIMA_AI_LEDGER_BACKFILL_NODE_BINARY=/usr/local/bin/node
export DIMA_AI_LEDGER_BACKFILL_NODE_DEPENDENCY_ROOT=/source/dimabot
export DIMA_RUST_TEST_RESOURCE_OWNER=dimabot-migration
export DIMA_TEST_MONGO_URI=mongodb://ai-ledger-backfill-mongo-fixture:27017
export DIMA_TEST_REDIS_URI=redis://ai-ledger-backfill-redis-fixture:6379/
export DIMA_AI_LEDGER_BACKFILL_RESOURCE_TOKEN=backfillnative20261029d
export DIMA_AI_LEDGER_BACKFILL_TEST_DATABASE=ai_ledger_backfill_test_backfillnative20261029d
printf '%s  %s\n' 594accd05c48591000541fe0d8edf5c527087905313f72df6c60d3dcc25a0c4f "$wave/bin/ai_usage_ledger_backfill" | sha256sum -c -
"$wave/bin/ai_usage_ledger_backfill" --nocapture
"$wave/bin/ai_usage_ledger_backfill" complete_actual_source_replay --ignored --exact --nocapture
"$wave/bin/ai_usage_ledger_backfill" private_mongo_redis_backfill_protocol_partial_failures_and_cancellation --ignored --exact --nocapture
printf '%s  %s\n' 594accd05c48591000541fe0d8edf5c527087905313f72df6c60d3dcc25a0c4f "$wave/bin/ai_usage_ledger_backfill" | sha256sum -c -
