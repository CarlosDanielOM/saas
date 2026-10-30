set -eu
export AI_CREDIT_READER_FIXTURE_ACK=private-task-owned-only
export AI_CREDIT_READER_MONGO_URL="$KEYWORD_FIXTURE_MONGO_URI"
export AI_CREDIT_READER_REDIS_URL="$KEYWORD_FIXTURE_REDIS_URL"
credit_owner=${KEYWORD_FIXTURE_NAMESPACE#keyword-fixture-}
credit_owner=${credit_owner%:}
export AI_CREDIT_READER_FIXTURE_NAMESPACE="credit-reader-fixture-$credit_owner"
export AI_CREDIT_READER_ORACLE_JSON=/artifacts/ai-credit-reader/attempt2/reference/reference.json
export AI_CREDIT_READER_ORACLE_SHA256=c11a50a2ebe61820764647258dbab9b0a4ca5b924fdc6abe94832152a1a0cd5f
export RUST_BACKTRACE=1
 timeout 180 cargo test --locked --offline --no-default-features --features ai-credit-reader --test ai_credit_reader private_mongo_redis_and_loopback_provider -- --ignored --exact --nocapture --test-threads=1
 timeout 180 cargo test --locked --offline --no-default-features --features ai-credit-reader --test ai_credit_reader_protocol private_reader_protocol_and_races -- --ignored --exact --nocapture --test-threads=1
