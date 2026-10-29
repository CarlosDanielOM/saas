set -eu
cargo fmt --all -- --check
cargo clippy --locked --offline --no-default-features --features moderation-emote-spam --lib --test moderation_emote_spam -- -D warnings
cargo test --locked --offline --no-default-features --features moderation-emote-spam --test moderation_emote_spam
