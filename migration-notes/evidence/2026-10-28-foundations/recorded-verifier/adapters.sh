set -eu
FEATURES=ast-blocks,ast-pure-functions,credit-policy,eventsub,chat-message,reward-body,domain-events,credential-crypto,jwt,application-schemas,keyword-store,domain-event-runtime,twitch-functions
cargo fmt --all -- --check
cargo check --locked --offline --keep-going --all-targets --no-default-features --features "$FEATURES"
cargo clippy --locked --offline --keep-going --all-targets --no-default-features --features "$FEATURES" -- -D warnings
cargo test --locked --offline --no-default-features --features "$FEATURES" --no-fail-fast
cargo test --locked --offline --no-default-features --features "$FEATURES" --test application_schemas native_schema_persistence_indexes_and_hooks -- --ignored --nocapture
cargo test --locked --offline --no-default-features --features "$FEATURES" --test additional_schemas additional_schema_native_indexes_conditions_immutability_and_maps -- --ignored --nocapture
cargo test --locked --offline --no-default-features --features "$FEATURES" --test keyword_native_adapters -- --ignored --nocapture
cargo test --locked --offline --no-default-features --features "$FEATURES" --test domain_event_runtime native_journal_races_owner_resolution_durability_wakeups_and_telemetry -- --ignored --nocapture
cargo test --locked --offline --no-default-features --features "$FEATURES" --test twitch_functions native_moderation_logging_and_notice_throttle_use_real_isolated_stores -- --ignored --nocapture
