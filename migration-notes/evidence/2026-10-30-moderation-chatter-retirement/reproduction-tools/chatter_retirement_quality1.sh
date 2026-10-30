set -eux
export TZ=UTC
export DIMA_CHATTER_SCHEMA_FIXTURE_DIR=/artifacts/chatter-retirement/attempt1/chatter
export DIMA_APPLICATION_SCHEMAS_FIXTURE_DIR=/artifacts/chatter-retirement/attempt1/application
export DIMA_ADDITIONAL_SCHEMAS_FIXTURE_DIR=/artifacts/chatter-retirement/attempt1/additional
export DIMA_ACTION_LOG_SCHEMA_FIXTURE_DIR=/artifacts/chatter-retirement/attempt1/action
export DIMA_CHATTER_SCHEMA_FIXTURE_SHA256=883c15dac75dcc472539ab71c0210dba1f78131ff64be5265ae6c82cddc7244f
export DIMA_APPLICATION_SCHEMAS_FIXTURE_SHA256=08bf1a37859778c2777215e0f8019987e60f9a6e750602a97d56016c85bf5687
export DIMA_ADDITIONAL_SCHEMAS_FIXTURE_SHA256=e62682246f26f79457aadfa97f44dffd9022377fa3c91331b5567a5c38f239a9
export DIMA_ACTION_LOG_SCHEMA_FIXTURE_SHA256=2376b909c43be9584396c65de5958d58304ff36e11ee6d4764f1fa408493312b
export SCHEMA_NAMED_TYPES_SHA256=b381280be7fe1315826cd6faf1207386d4cf1ec0e639eb2e503f56b20edbeabd
export TIMER_CHAT_TYPES_SHA256=a7eabb843dcf1e7d1e944bfac98ca46c62e1e6908187ebb242c12548ed2acb95
export FISH_FAVORITES_ORACLE_SHA256=02f9d9afadc122d82d5692a023edc5ce3d928c71cb3af082bd732a5f50f58b29
export DIMA_SPAM_REFERENCE_SHA256=bd682f476565af1918007b335fa4ddd11b9c127c5aa57799448d1da9dcd2a3cd
export SCHEMA_NAMED_TYPES_FIXTURE=/artifacts/chatter-retirement/attempt1/named/schema-named-types-reference.json
export TIMER_CHAT_TYPES_FIXTURE=/artifacts/chatter-retirement/attempt1/timer/timer-chat-schema-types-reference.json
export FISH_FAVORITES_ORACLE=/artifacts/chatter-retirement/attempt1/fish/channel_fish_voice_favorites.json
export DIMA_SPAM_REFERENCE=/artifacts/chatter-retirement/attempt1/spam/moderation-spam-reference.json
export DIMA_SPAM_LOADER_SHA256=b5cf1d8d5c0f7105e8042ce47dd323486ff000e5a7b4695716db76f010dc6558
export DIMA_SPAM_READER_SHA256=3cd07fee4740325e384792737a396ce4ad1b69a5988c338f8a0f6b37f6f3dfd5
cargo fmt --all -- --check
cargo test --locked --offline --no-default-features --features moderation-spam,moderation-action-log-schema,channel-fish-voice-favorites --test moderation_chatter_schema -- --include-ignored --nocapture --test-threads=1
cargo test --locked --offline --no-default-features --features moderation-spam,moderation-action-log-schema,channel-fish-voice-favorites --test moderation_spam --test moderation_spam_source --test timer_chat_schema_types --test additional_schemas --test application_schemas --test schema_named_types --test moderation_action_log_schema --test channel_fish_voice_favorites
cargo test --locked --offline --no-default-features --features moderation-spam,moderation-action-log-schema,channel-fish-voice-favorites --test moderation_spam_source all_pure_source_records -- --ignored --exact --nocapture
cargo test --locked --offline --no-default-features --features moderation-spam,moderation-action-log-schema,channel-fish-voice-favorites --test timer_chat_schema_types source_oracle_and_bson_boundaries -- --ignored --exact --nocapture
cargo test --locked --offline --no-default-features --features moderation-spam,moderation-action-log-schema,channel-fish-voice-favorites --test schema_named_types source_oracle_and_catalogs -- --ignored --exact --nocapture
cargo test --locked --offline --no-default-features --features moderation-spam,moderation-action-log-schema,channel-fish-voice-favorites --test moderation_action_log_schema replay_actual_mongoose_source -- --ignored --exact --nocapture
cargo test --locked --offline --no-default-features --features moderation-spam,moderation-action-log-schema,channel-fish-voice-favorites --test channel_fish_voice_favorites source_oracle_pure_and_protocol -- --ignored --exact --nocapture
cargo clippy --locked --offline --no-default-features --features moderation-spam,moderation-action-log-schema,channel-fish-voice-favorites --all-targets -- -D warnings
cargo check --locked --offline --no-default-features --all-targets
cargo clippy --locked --offline --all-features --all-targets -- -D warnings
