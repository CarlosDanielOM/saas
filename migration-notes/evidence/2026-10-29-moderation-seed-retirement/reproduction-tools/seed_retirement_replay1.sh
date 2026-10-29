set -eu
export DIMA_SEED_PLAN_FIXTURE_DIR=/artifacts/moderation-seed-retirement/attempt1/seed-reference
export DIMA_SEED_PLAN_FIXTURE_SHA256=4e22ebfb480f8cfc98340669e90f2166e59a90b19602ae73fb1c7322aaf93d99
export DIMA_CAPS_REFERENCE_DIR=/artifacts/moderation-seed-retirement/attempt1/caps-reference
export DIMA_EMOTE_SPAM_REFERENCE_DIR=/artifacts/moderation-seed-retirement/attempt1/emote-reference
cargo test --locked --offline --no-default-features --features moderation-seed-plan,moderation-emote-spam --test moderation_seed_plan --test moderation_caps --test moderation_emote_spam -- --ignored --nocapture
cargo check --locked --offline --no-default-features --all-targets
cargo check --locked --offline --no-default-features --features mongo,redis --all-targets
cargo check --locked --offline --all-features --all-targets
cargo clippy --locked --offline --all-features --all-targets -- -D warnings
