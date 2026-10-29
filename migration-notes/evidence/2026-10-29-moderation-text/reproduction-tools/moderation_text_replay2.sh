set -eu
export DIMA_LINKS_REFERENCE_DIR=/artifacts/moderation-text/attempt2/links-reference
export DIMA_MODERATION_NORMALIZE_FIXTURE_DIR=/artifacts/moderation-text/attempt2/normalize-reference
export DIMA_MODERATION_NORMALIZE_FIXTURE_SHA256=d83ed5947d5cb2bf17d7c2bd0eedebe986c07cec592041804310667e87fedc0e
cargo test --locked --offline --no-default-features --features moderation-links,moderation-normalize --test moderation_links --test moderation_normalize -- --ignored --nocapture
cargo test --locked --offline --no-default-features --features moderation-links,moderation-normalize,moderation-caps,moderation-emote-spam --test moderation_caps --test moderation_emote_spam
cargo check --locked --offline --no-default-features --all-targets
cargo check --locked --offline --no-default-features --features mongo,redis --all-targets
cargo check --locked --offline --all-features --all-targets
cargo clippy --locked --offline --all-features --all-targets -- -D warnings
