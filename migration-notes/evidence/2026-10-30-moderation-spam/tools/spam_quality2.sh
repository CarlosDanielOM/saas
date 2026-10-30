set -eu
cargo fmt --all -- --check
. /task-tools/spam_node_env4.sh
export DIMA_SPAM_REFERENCE=/artifacts/moderation-spam/attempt4/reference/moderation-spam-reference.json
export DIMA_SPAM_REFERENCE_SHA256=f6f59d6c0a021ce609ac507ed88af22960eb2cf683c31d19ec3c146a2aebc222
export DIMA_SPAM_PRIVATE_FIXTURE_OWNER="$KEYWORD_FIXTURE_NAMESPACE"
export DIMA_SPAM_FAILPOINT_OWNER="$KEYWORD_FIXTURE_NAMESPACE"
export RUST_BACKTRACE=1
cargo test --locked --offline --no-default-features --features moderation-spam --test moderation_spam
 timeout 180 cargo test --locked --offline --no-default-features --features moderation-spam --test moderation_spam_source all_pure_source_records -- --ignored --exact --nocapture
 timeout 180 cargo test --locked --offline --no-default-features --features moderation-spam --test moderation_spam_source all_async_source_records_through_private_protocols -- --ignored --exact --nocapture
 timeout 180 cargo test --locked --offline --no-default-features --features moderation-spam --test moderation_spam_storage -- --ignored --test-threads=1 --nocapture

for probe in isolated_bootstrap_probes applied_response_loss_is_not_retried explicit_telemetry_records_success_errors_and_cache_lookup; do
 timeout 90 cargo test --locked --offline --no-default-features --features moderation-spam --test moderation_spam_bootstrap "$probe" -- --ignored --exact --nocapture
done
cargo clippy --locked --offline --no-default-features --features moderation-spam --all-targets --keep-going -- -D warnings
cargo check --locked --offline --no-default-features --all-targets
cargo check --locked --offline --no-default-features --features mongo,redis --all-targets
cargo clippy --locked --offline --all-features --all-targets --keep-going -- -D warnings
