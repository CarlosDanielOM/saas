set -eu
cargo fmt --all -- --check
cargo clippy --locked --offline --no-default-features --features ai-usage,tts-utilities --lib --test ai_usage_classification -- -D warnings
cargo test --locked --offline --no-default-features --features ai-usage,tts-utilities --test ai_usage_classification
cargo test --locked --offline --no-default-features --features ai-usage,tts-utilities --lib utils::ai_usage
