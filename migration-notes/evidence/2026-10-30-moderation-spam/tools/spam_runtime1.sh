set -eu
. /task-tools/spam_node_env2.sh
export DIMA_SPAM_REFERENCE=/artifacts/moderation-spam/attempt2/reference/moderation-spam-reference.json
export DIMA_SPAM_REFERENCE_SHA256=37e87e1e6d04673e8b34a7a32349dfc33a643326c76376deb85c391fc72310a1
export DIMA_SPAM_PRIVATE_FIXTURE_OWNER="$KEYWORD_FIXTURE_NAMESPACE"
export DIMA_SPAM_FAILPOINT_OWNER="$KEYWORD_FIXTURE_NAMESPACE"
export RUST_BACKTRACE=1
cargo test --locked --offline --no-default-features --features moderation-spam --test moderation_spam
 timeout 180 cargo test --locked --offline --no-default-features --features moderation-spam --test moderation_spam_source all_pure_source_records -- --ignored --exact --nocapture
 timeout 180 cargo test --locked --offline --no-default-features --features moderation-spam --test moderation_spam_source all_async_source_records_through_private_protocols -- --ignored --exact --nocapture
 timeout 180 cargo test --locked --offline --no-default-features --features moderation-spam --test moderation_spam_storage -- --ignored --test-threads=1 --nocapture
