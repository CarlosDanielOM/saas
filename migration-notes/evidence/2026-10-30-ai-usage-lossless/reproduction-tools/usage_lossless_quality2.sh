set -eu
export AI_USAGE_LOSSLESS_REFERENCE_DIR=/artifacts/ai-usage-lossless/attempt1/reference
export AI_USAGE_LOSSLESS_REFERENCE_SHA256=442013548f86179ab01de38d2c609d4fddc47f187f029281d035898574e8b598
cargo fmt --all -- --check
cargo test --locked --offline --no-default-features --features ai-usage-lossless --test ai_usage_lossless -- --include-ignored --nocapture
cargo clippy --locked --offline --no-default-features --features ai-usage-lossless --all-targets --keep-going -- -D warnings
cargo check --locked --offline --no-default-features --all-targets
cargo check --locked --offline --no-default-features --features mongo,redis --all-targets
cargo clippy --locked --offline --all-features --all-targets --keep-going -- -D warnings
