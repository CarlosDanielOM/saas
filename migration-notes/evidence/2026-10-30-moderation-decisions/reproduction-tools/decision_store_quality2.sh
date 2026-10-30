set -eu
. /task-tools/decision_store_node_env2.sh
export DIMA_DECISIONS_REFERENCE=/artifacts/moderation-decisions/attempt2/reference/moderation-decisions-reference.json
export DIMA_DECISIONS_REFERENCE_SHA256=ade6b18d2fb680e2b1a74e30d508d83cde891439fe14b2429d2487f154231b9f
export DIMA_DECISIONS_SDK_SOURCE_ROOT=/artifacts/moderation-decisions/attempt1/source-provenance
export DIMA_VARIATION_JOBS_FAILPOINT_OWNER="$KEYWORD_FIXTURE_NAMESPACE"
export RUST_BACKTRACE=1
cargo fmt --all -- --check
cargo test --locked --offline --no-default-features --features moderation-decisions --test moderation_decisions
 timeout 300 cargo test --locked --offline --no-default-features --features moderation-decisions --test moderation_decisions -- --ignored --nocapture --test-threads=1
cargo test --locked --offline --no-default-features --features moderation-variations-provider --test moderation_variations --test moderation_variations_provider
DIMA_VARIATIONS_REFERENCE=/artifacts/moderation-variations/attempt1/reference/moderation-variations-reference.json DIMA_VARIATIONS_REFERENCE_SHA256=1d3ab58bd78a0d34b60e139b24901920fe32d1e32de3e96bd6db486b14e39c54 cargo test --locked --offline --no-default-features --features moderation-variations-provider --test moderation_variations external_source_fixture_replays_native_value_calls -- --ignored --exact --nocapture
. /task-tools/variation_jobs_runtime2.sh
cargo clippy --locked --offline --no-default-features --features moderation-decisions --all-targets --keep-going -- -D warnings
cargo check --locked --offline --no-default-features --all-targets
cargo check --locked --offline --no-default-features --features mongo,redis --all-targets
cargo clippy --locked --offline --all-features --all-targets --keep-going -- -D warnings
