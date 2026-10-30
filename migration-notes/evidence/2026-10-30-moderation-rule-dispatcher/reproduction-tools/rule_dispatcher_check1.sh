set -eu
cargo fmt --all -- --check
cargo test --locked --offline --no-default-features --features moderation-rules --test moderation_rule_dispatcher --test moderation_blacklist --test moderation_caps --test moderation_emote_spam --test moderation_links --test moderation_normalize
cargo clippy --locked --offline --no-default-features --features moderation-rules --all-targets -- -D warnings
