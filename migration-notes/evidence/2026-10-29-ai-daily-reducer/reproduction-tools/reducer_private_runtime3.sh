set -eu
export TZ=UTC
wave=/artifacts/ledger-reducer-benchmark/attempt3
export DIMA_AI_LEDGER_PERSISTENCE_REFERENCE_DIR="$wave/persistence-reference"
export DIMA_AI_LOCK_REFERENCE_DIR=/artifacts/ledger-persistence/attempt2/lock
export DIMA_AI_LEDGER_PERSISTENCE_NODE_BINARY=/usr/local/bin/node
export DIMA_AI_LEDGER_PERSISTENCE_NODE_DEPENDENCY_ROOT=/source/dimabot
export DIMA_RUST_TEST_RESOURCE_OWNER=dimabot-migration
export DIMA_TEST_MONGO_URI=mongodb://ai-ledger-persistence-mongo-fixture:27017
export DIMA_TEST_REDIS_URI=redis://ai-ledger-persistence-redis-fixture:6379/
export DIMA_AI_LEDGER_PERSISTENCE_RESOURCE_TOKEN=reducernative20261029c
export DIMA_AI_LEDGER_PERSISTENCE_TEST_DATABASE=ai_ledger_persistence_test_reducernative20261029c
printf '%s  %s\n' f7963d55a3c7d1b7756ff1f5cf3441cd0e7b8bd83c4367439e4c5d73c300324d "$wave/bin/ai_usage_ledger_persistence" | sha256sum -c -
"$wave/bin/ai_usage_ledger_persistence" private_mongo_and_real_redis_persistence_protocol --ignored --exact --nocapture
printf '%s  %s\n' f7963d55a3c7d1b7756ff1f5cf3441cd0e7b8bd83c4367439e4c5d73c300324d "$wave/bin/ai_usage_ledger_persistence" | sha256sum -c -
