set -eu
export DIMA_VARIATION_JOBS_REFERENCE=/artifacts/moderation-variation-jobs/attempt1/reference/moderation-variation-jobs-reference.json
export DIMA_VARIATION_JOBS_REFERENCE_SHA256=4bc9a8afee384bd554514eea3cf26ca9ea120c739348818e3a5d6ee7e9587e1b
export DIMA_VARIATION_JOBS_SOURCE_ROOT=/artifacts/moderation-variation-jobs/attempt1/source-provenance
export DIMA_VARIATION_JOBS_FAILPOINT_OWNER="$KEYWORD_FIXTURE_NAMESPACE"
export RUST_BACKTRACE=1
cargo test --locked --offline --no-default-features --features moderation-variation-jobs --test moderation_variation_jobs --test moderation_variation_jobs_bootstrap
 timeout 300 cargo test --locked --offline --no-default-features --features moderation-variation-jobs --test moderation_variation_jobs_source -- --ignored --test-threads=1 --nocapture
 timeout 180 cargo test --locked --offline --no-default-features --features moderation-variation-jobs --test moderation_variation_jobs -- --ignored --test-threads=1 --nocapture

timeout 90 cargo test --locked --offline --no-default-features --features moderation-variation-jobs --test moderation_variation_jobs_bootstrap isolated_bootstrap_probes -- --ignored --exact --nocapture
