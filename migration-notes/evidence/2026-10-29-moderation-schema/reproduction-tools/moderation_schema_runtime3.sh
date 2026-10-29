set -eu
export DIMA_SCHEMA_COMPOSITE_FIXTURE_DIR=/artifacts/moderation-schema/attempt3/core-reference
export DIMA_SCHEMA_COMPOSITE_FIXTURE_SHA256=d00d4454a19bb3be0a6747f32adbfa625349ef0c3522825d81b622ebd53996d5
export DIMA_MODERATION_SCHEMA_REFERENCE_DIR=/artifacts/moderation-schema/attempt3/model-reference
export DIMA_MODERATION_SCHEMA_REFERENCE_SHA256=55720bfc3a1f02c642ff3a168a49e699802e6bf14ee94b1dca34c9326cad5604
cargo test --locked --offline --no-default-features --features channel-moderation-settings --test schema_composite_defaults --test channel_moderation_settings_schema -- --ignored --nocapture
export DIMA_MODERATION_SCHEMA_TEST_OWNER=moderationschema20261029a3
export DIMA_MODERATION_SCHEMA_MONGO_ENDPOINT=moderation-schema-mongo-taskowned:27017
export DIMA_MODERATION_SCHEMA_MONGO_URI=mongodb://moderation-schema-mongo-taskowned:27017
cargo test --locked --offline --no-default-features --features channel-moderation-settings --test channel_moderation_settings_store -- --ignored --nocapture
cargo test --locked --offline --no-default-features --features channel-moderation-settings,channel-tts-settings --test application_schemas --test additional_schemas --test schema_core_contracts --test channel_tts_settings_schema
cargo test --locked --offline --no-default-features --features application-schemas --test application_schemas native_schema_persistence_indexes_and_hooks -- --ignored --exact --nocapture
cargo check --locked --offline --no-default-features --all-targets
cargo check --locked --offline --no-default-features --features mongo,redis --all-targets
cargo check --locked --offline --all-features --all-targets
cargo clippy --locked --offline --all-features --all-targets -- -D warnings
