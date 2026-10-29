set -eu
export DIMA_SCHEMA_COMPOSITE_FIXTURE_DIR=/artifacts/moderation-schema/attempt4/core-reference
export DIMA_SCHEMA_COMPOSITE_FIXTURE_SHA256=5999a0291f26fd7bdf99fe19fe7cc142956f7728238b2016d6878e49067b496f
export DIMA_MODERATION_SCHEMA_REFERENCE_DIR=/artifacts/moderation-schema/attempt4/model-reference
export DIMA_MODERATION_SCHEMA_REFERENCE_SHA256=fdde5d664248f3d5cb5e36ed0a94ada5676bd25a610945754f188c18e02e7a25
cargo test --locked --offline --no-default-features --features channel-moderation-settings --test schema_composite_defaults --test channel_moderation_settings_schema -- --ignored --nocapture
export DIMA_MODERATION_SCHEMA_TEST_OWNER=moderationschema20261029a4
export DIMA_MODERATION_SCHEMA_MONGO_ENDPOINT=moderation-schema-mongo-taskowned:27017
export DIMA_MODERATION_SCHEMA_MONGO_URI=mongodb://moderation-schema-mongo-taskowned:27017
cargo test --locked --offline --no-default-features --features channel-moderation-settings --test channel_moderation_settings_store -- --ignored --nocapture
cargo test --locked --offline --no-default-features --features channel-moderation-settings,channel-tts-settings --test application_schemas --test additional_schemas --test schema_core_contracts --test channel_tts_settings_schema
cargo test --locked --offline --no-default-features --features application-schemas --test application_schemas native_schema_persistence_indexes_and_hooks -- --ignored --exact --nocapture
cargo check --locked --offline --no-default-features --all-targets
cargo check --locked --offline --no-default-features --features mongo,redis --all-targets
cargo check --locked --offline --all-features --all-targets
cargo clippy --locked --offline --all-features --all-targets -- -D warnings
