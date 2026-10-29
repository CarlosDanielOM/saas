set -eu
export DIMA_SCHEMA_COMPOSITE_FIXTURE_DIR=/artifacts/moderation-schema/attempt2/core-reference
export DIMA_SCHEMA_COMPOSITE_FIXTURE_SHA256=b8c42ec12eb4876997b252c31c647ea5a6997c3c34e4467dbfd38d9e9fca7022
export DIMA_MODERATION_SCHEMA_REFERENCE_DIR=/artifacts/moderation-schema/attempt2/model-reference
export DIMA_MODERATION_SCHEMA_REFERENCE_SHA256=584b4982e71a90108160e678c7b5cbddd854a1091445bff4de8132d470b6bb06
cargo test --locked --offline --no-default-features --features channel-moderation-settings --test schema_composite_defaults -- --ignored --nocapture
cargo test --locked --offline --no-default-features --features channel-moderation-settings --test channel_moderation_settings_schema -- --ignored --nocapture
