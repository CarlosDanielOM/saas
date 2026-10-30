set -eu
cargo check --locked --offline --no-default-features --features moderation-variation-storage --tests
cargo test --locked --offline --no-default-features --features moderation-variation-storage --test moderation_variation_schema
DIMA_VARIATION_SCHEMA_FIXTURE_DIR=/artifacts/moderation-variation-schema/attempt3/reference DIMA_VARIATION_SCHEMA_FIXTURE_SHA256=fc419312c63aa5ef13f441dccc8353dd5f538690ffc2ddc6fd62035dcb81840a cargo test --locked --offline --no-default-features --features moderation-variation-storage --test moderation_variation_schema replay_actual_mongoose_source -- --ignored --exact --nocapture
