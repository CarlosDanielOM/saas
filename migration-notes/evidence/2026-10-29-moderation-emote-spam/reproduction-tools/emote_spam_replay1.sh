set -eu
export DIMA_EMOTE_SPAM_REFERENCE_DIR=/artifacts/moderation-emote-spam/attempt1/reference
cargo test --locked --offline --no-default-features --features moderation-emote-spam --test moderation_emote_spam replay_actual_source_oracle -- --ignored --exact --nocapture
cargo check --locked --offline --no-default-features --all-targets
cargo check --locked --offline --no-default-features --features mongo,redis --all-targets
cargo check --locked --offline --all-features --all-targets
cargo clippy --locked --offline --all-features --all-targets -- -D warnings
