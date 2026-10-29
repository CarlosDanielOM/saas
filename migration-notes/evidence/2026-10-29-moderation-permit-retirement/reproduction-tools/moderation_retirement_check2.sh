set -eu
cargo test --locked --offline --no-default-features --features moderation-permit --lib utils::moderation::permit::tests::read_tasks_keep_parent_telemetry_context -- --exact --nocapture
cargo fmt --all -- --check
cargo clippy --locked --offline --no-default-features --features moderation-caps,moderation-emote-spam,moderation-permit --all-targets -- -D warnings
cargo test --locked --offline --no-default-features --features moderation-caps,moderation-emote-spam,moderation-permit --test moderation_caps --test moderation_emote_spam --test moderation_permit
cargo test --locked --offline --no-default-features --features moderation-permit --lib utils::moderation::permit
