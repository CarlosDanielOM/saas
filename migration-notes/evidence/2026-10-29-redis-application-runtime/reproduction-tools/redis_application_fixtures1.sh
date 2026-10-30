set -eu
cargo test --locked --offline --no-default-features --features moderation-permit,moderation-offenses --test redis_application_runtime isolated_runtime_probes -- --ignored --exact --nocapture
