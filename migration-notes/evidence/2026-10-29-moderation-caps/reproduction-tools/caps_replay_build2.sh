set -eu
export DIMA_CAPS_REFERENCE_DIR=/artifacts/moderation-caps/attempt2/reference
cargo test --locked --offline --no-default-features --features moderation-caps --test moderation_caps replay_actual_source -- --ignored --exact --nocapture
cargo test --release --locked --offline --no-default-features --features moderation-caps --test moderation_caps_benchmark --no-run --message-format=json > /artifacts/moderation-caps/attempt2/benchmark-build.jsonl
cargo check --locked --offline --no-default-features --all-targets
cargo check --locked --offline --no-default-features --features mongo,redis --all-targets
cargo check --locked --offline --all-features --all-targets
cargo clippy --locked --offline --all-features --all-targets -- -D warnings
