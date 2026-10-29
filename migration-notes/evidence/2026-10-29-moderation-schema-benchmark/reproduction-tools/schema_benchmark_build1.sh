set -eu
cargo fmt --all -- --check
cargo clippy --locked --offline --no-default-features --features channel-moderation-settings --all-targets -- -D warnings
cargo test --release --locked --offline --no-default-features --features channel-moderation-settings --test channel_moderation_settings_benchmark --no-run --message-format=json > /artifacts/moderation-schema-benchmark/attempt1/benchmark-build.jsonl
