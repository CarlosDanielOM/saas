set -eu
. /task-tools/decision_store_node_env1.sh
export DIMA_DECISIONS_REFERENCE=/artifacts/moderation-decisions/attempt1/reference/moderation-decisions-reference.json
export DIMA_DECISIONS_REFERENCE_SHA256=d99472b85a1bf322c11e0d4ecb1f54a747602d31870b889f3b31dd88ea0918e1
export DIMA_DECISIONS_SDK_SOURCE_ROOT=/artifacts/moderation-decisions/attempt1/source-provenance
export RUST_BACKTRACE=1
cargo test --locked --offline --no-default-features --features moderation-decisions --test moderation_decisions source_reference_hash_and_pre_cast_creation_replay -- --ignored --exact --nocapture
cargo test --locked --offline --no-default-features --features moderation-decisions --test moderation_decisions source_mongoose_query_probe_compares_cast_insert_wire_shape -- --ignored --exact --nocapture
