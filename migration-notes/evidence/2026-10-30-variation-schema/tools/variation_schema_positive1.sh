set -eu
cargo check --locked --offline --no-default-features --features moderation-variation-storage --tests
cargo test --locked --offline --no-default-features --features moderation-variation-storage --test moderation_variation_schema
DIMA_VARIATION_SCHEMA_FIXTURE_DIR=/artifacts/moderation-variation-schema/attempt2/reference DIMA_VARIATION_SCHEMA_FIXTURE_SHA256=91dcb781a5b90f3b51a6dbac26bd54c3bfce9f624e6e82a9714b20d23ab56701 cargo test --locked --offline --no-default-features --features moderation-variation-storage --test moderation_variation_schema replay_actual_mongoose_source -- --ignored --exact --nocapture
