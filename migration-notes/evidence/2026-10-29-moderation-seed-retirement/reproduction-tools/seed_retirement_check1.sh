set -eu
cargo fmt --all -- --check
cargo test --locked --offline --no-default-features --features moderation-seed-plan,moderation-emote-spam --test moderation_seed_plan --test moderation_caps --test moderation_emote_spam
cargo clippy --locked --offline --no-default-features --features moderation-seed-plan,moderation-emote-spam --all-targets -- -D warnings
