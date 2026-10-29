set -eu
export DIMA_CAPS_REFERENCE_DIR=/artifacts/moderation-rule-retirement/attempt2/caps-reference
export DIMA_EMOTE_SPAM_REFERENCE_DIR=/artifacts/moderation-rule-retirement/attempt2/emote-reference
export DIMA_PERMIT_FIXTURE_DIR=/artifacts/moderation-rule-retirement/attempt2/permit-reference
export DIMA_PERMIT_FIXTURE_SHA256=50266811360c5bb833f8db4c63404ecb7191160943cdd64c856e8058fe17145f
cargo test --locked --offline --no-default-features --features moderation-caps,moderation-emote-spam,moderation-permit --test moderation_caps --test moderation_emote_spam --test moderation_permit -- --ignored --nocapture
cargo test --locked --offline --no-default-features --features moderation-permit --test moderation_permit_redis -- --ignored --nocapture --test-threads=1
cargo check --locked --offline --no-default-features --all-targets
cargo check --locked --offline --no-default-features --features mongo,redis --all-targets
cargo check --locked --offline --all-features --all-targets
cargo clippy --locked --offline --all-features --all-targets -- -D warnings
