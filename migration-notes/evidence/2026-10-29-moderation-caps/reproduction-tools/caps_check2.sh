set -eu
cargo fmt --all -- --check
cargo clippy --locked --offline --no-default-features --features moderation-caps --lib --test moderation_caps --test moderation_caps_benchmark -- -D warnings
cargo test --locked --offline --no-default-features --features moderation-caps --test moderation_caps
