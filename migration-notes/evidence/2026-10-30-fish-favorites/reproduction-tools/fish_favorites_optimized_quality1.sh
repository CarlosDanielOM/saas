#!/bin/sh
set -eu
cd /source/dimabot
export TIMER_CHAT_TYPES_FIXTURE=/artifacts/fish-favorites/optimized1/schema/timer/timer-chat-schema-types-reference.json
export TIMER_CHAT_TYPES_SHA256=64598d9ca34bc9d43ce82bd5dfe1b547c348cd27b9067ca304832324c6b7eac4
export SCHEMA_NAMED_TYPES_FIXTURE=/artifacts/fish-favorites/optimized1/schema/named/schema-named-types-reference.json
export SCHEMA_NAMED_TYPES_SHA256=8be5c2f679f6835837e501412e9acb4f056cdf96006cd4ebf6a96696e5d94bb6
export DIMA_ADDITIONAL_SCHEMAS_FIXTURE_DIR=/artifacts/fish-favorites/optimized1/schema/additional
export DIMA_ADDITIONAL_SCHEMAS_FIXTURE_SHA256=b9b6becfb4852bdb2cdac1b45a04e6e3d5f2a6ce3aa4094d9de8013bc2de474d
export DIMA_APPLICATION_SCHEMAS_FIXTURE_DIR=/artifacts/fish-favorites/optimized1/schema/application
export DIMA_APPLICATION_SCHEMAS_FIXTURE_SHA256=45c3d5b364528cd4f04b1cf22178445527af33d46d94e4312daa07e867aa958a
export DIMA_ACTION_LOG_SCHEMA_FIXTURE_DIR=/artifacts/fish-favorites/optimized1/schema/action
export DIMA_ACTION_LOG_SCHEMA_FIXTURE_SHA256=ae0052604904005a4dafcf69bd2c188a2620917cac2b48ada42a4906028f44ba
export FISH_FAVORITES_ORACLE=/artifacts/fish-favorites/optimized1/oracle/channel_fish_voice_favorites.json
export FISH_FAVORITES_ORACLE_SHA256=209d28cc8d0ca1b84d54583286002b205091e3a1cc9668c5a6839390da53a981
export JS_NFKD_ORACLE=/artifacts/fish-favorites/optimized1/nfkd/js_unicode_nfkd.json
export JS_NFKD_ORACLE_SHA256=e19010bbb5672dd7be3aa5c6de20ffa9b2f94a88640cbbd2aeb0af8b79130279
export DIMA_JS_NFC_DIR=/artifacts/fish-favorites/optimized1/nfc
export DIMA_JS_NFC_SHA256=c32934cd6a1a132e0848b0e6cbf7887bdeccd5ff162db0ae02704bbb718af153
export TZ=UTC
export MONGOOSE_DATE_FIXTURE=/artifacts/fish-favorites/optimized1/mongoose-date/UTC.json
cargo fmt --all -- --check
DIMA_RUST_TEST_RESOURCE_OWNER=fish-voice-favorites FISH_FAVORITES_MONGO_URI=mongodb://keyword-mongo:27017 FISH_FAVORITES_NAMESPACE=fish-favorites-fca01b6f57a8: cargo test --locked --offline --no-default-features --features channel-fish-voice-favorites --test channel_fish_voice_favorites -- --include-ignored --nocapture --test-threads=1
cargo test --locked --offline --no-default-features --features js-unicode17 --test js_unicode --test js_unicode_nfc --test js_unicode_nfkd
cargo test --release --locked --offline --no-default-features --features js-unicode17 --test js_unicode_nfkd pinned_node_all_scalar_and_mixed_nfkd -- --ignored --exact
cargo test --release --locked --offline --no-default-features --features js-unicode17 --test js_unicode_nfc replay_all_codepoints_and_contexts_from_pinned_node -- --ignored --exact
cargo test --locked --offline --no-default-features --features moderation-action-log-schema --test timer_chat_schema_types --test additional_schemas --test application_schemas --test schema_named_types --test moderation_action_log_schema --test mongoose_date
cargo test --locked --offline --no-default-features --features application-schemas --test timer_chat_schema_types source_oracle_and_bson_boundaries -- --ignored --exact
cargo test --locked --offline --no-default-features --features application-schemas --test schema_named_types source_oracle_and_catalogs -- --ignored --exact
cargo test --locked --offline --no-default-features --features moderation-action-log-schema --test moderation_action_log_schema replay_actual_mongoose_source -- --ignored --exact
cargo clippy --locked --offline --no-default-features --features channel-fish-voice-favorites --all-targets -- -D warnings
cargo check --locked --offline --no-default-features --all-targets
cargo clippy --locked --offline --all-features --all-targets -- -D warnings
