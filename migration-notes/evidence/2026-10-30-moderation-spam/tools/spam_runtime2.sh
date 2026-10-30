set -eu
. /task-tools/spam_node_env3.sh
export DIMA_SPAM_REFERENCE=/artifacts/moderation-spam/attempt3/reference/moderation-spam-reference.json
export DIMA_SPAM_REFERENCE_SHA256=58c8d39d59b9742a7a6b991a5e24598fc87781da57dc1b172f4e0b9c02561577
export DIMA_SPAM_PRIVATE_FIXTURE_OWNER="$KEYWORD_FIXTURE_NAMESPACE"
export DIMA_SPAM_FAILPOINT_OWNER="$KEYWORD_FIXTURE_NAMESPACE"
export RUST_BACKTRACE=1
cargo test --locked --offline --no-default-features --features moderation-spam --test moderation_spam
 timeout 180 cargo test --locked --offline --no-default-features --features moderation-spam --test moderation_spam_source all_pure_source_records -- --ignored --exact --nocapture
 timeout 180 cargo test --locked --offline --no-default-features --features moderation-spam --test moderation_spam_source all_async_source_records_through_private_protocols -- --ignored --exact --nocapture
 timeout 180 cargo test --locked --offline --no-default-features --features moderation-spam --test moderation_spam_storage -- --ignored --test-threads=1 --nocapture

cargo clippy --locked --offline --no-default-features --features moderation-spam --all-targets --keep-going -- -D warnings
