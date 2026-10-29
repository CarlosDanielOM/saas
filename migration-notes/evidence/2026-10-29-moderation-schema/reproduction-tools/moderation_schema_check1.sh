set -eu
cargo fmt --all -- --check
cargo test --locked --offline --no-default-features --features channel-moderation-settings --test schema_composite_defaults --test channel_moderation_settings_schema
cargo clippy --locked --offline --no-default-features --features channel-moderation-settings --all-targets -- -D warnings
