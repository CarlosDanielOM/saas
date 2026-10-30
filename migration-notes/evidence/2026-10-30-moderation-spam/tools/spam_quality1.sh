set -eu
cargo fmt --all -- --check
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

for probe in isolated_bootstrap_probes applied_response_loss_is_not_retried explicit_telemetry_records_success_errors_and_cache_lookup; do
 timeout 90 cargo test --locked --offline --no-default-features --features moderation-spam --test moderation_spam_bootstrap "$probe" -- --ignored --exact --nocapture
done
export DIMA_VARIATION_JOBS_REFERENCE=/artifacts/moderation-variation-jobs/attempt1/reference/moderation-variation-jobs-reference.json
export DIMA_VARIATION_JOBS_REFERENCE_SHA256=4bc9a8afee384bd554514eea3cf26ca9ea120c739348818e3a5d6ee7e9587e1b
export DIMA_VARIATION_JOBS_SOURCE_ROOT=/artifacts/moderation-variation-jobs/attempt1/source-provenance
export DIMA_VARIATION_JOBS_FAILPOINT_OWNER="$KEYWORD_FIXTURE_NAMESPACE"
timeout 120 cargo test --locked --offline --no-default-features --features moderation-variation-jobs --test moderation_variation_jobs_source -- --ignored --test-threads=1 --nocapture
cargo clippy --locked --offline --no-default-features --features moderation-spam --all-targets --keep-going -- -D warnings
cargo check --locked --offline --no-default-features --all-targets
cargo check --locked --offline --no-default-features --features mongo,redis --all-targets
cargo clippy --locked --offline --all-features --all-targets --keep-going -- -D warnings
