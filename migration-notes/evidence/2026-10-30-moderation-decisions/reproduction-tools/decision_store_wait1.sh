set -eu
. /task-tools/decision_store_node_env1.sh
export DIMA_DECISIONS_REFERENCE=/artifacts/moderation-decisions/attempt1/reference/moderation-decisions-reference.json
export DIMA_DECISIONS_REFERENCE_SHA256=d99472b85a1bf322c11e0d4ecb1f54a747602d31870b889f3b31dd88ea0918e1
export DIMA_DECISIONS_SDK_SOURCE_ROOT=/artifacts/moderation-decisions/attempt1/source-provenance
export DIMA_VARIATION_JOBS_FAILPOINT_OWNER="$KEYWORD_FIXTURE_NAMESPACE"
export RUST_BACKTRACE=1
for check in source_reference_await_results_against_disposable_mongo disposable_read_crossing_deadline_returns_ready_or_fences_pending disposable_worker_result_racing_timeout_is_fenced disposable_applied_timeout_write_lost_reply_has_no_application_replay; do
 timeout 180 cargo test --locked --offline --no-default-features --features moderation-decisions --test moderation_decisions "$check" -- --ignored --exact --nocapture --test-threads=1
done
