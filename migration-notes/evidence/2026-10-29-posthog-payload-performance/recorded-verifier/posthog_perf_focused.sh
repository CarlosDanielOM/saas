set -eu
wave=/artifacts/posthog-payload-performance/attempt1
export POSTHOG_TRACKING_FIXTURES="$wave/tracking"
export POSTHOG_LOSSLESS_REFERENCE_DIR="$wave/transport"
export POSTHOG_BENCH_DIR="$wave/benchmark"
export POSTHOG_BENCH_INPUT_SHA256=b128c33d0a1f376806ef2a2b53dcee0c5548af0d9767c750df4d82f325efbfde
sha256sum "$wave/benchmark/input.json" "$wave/benchmark/node-report.json" > "$wave/focused-inputs-before.sha256"
cargo test --locked --offline --no-default-features --features posthog-benchmark --lib --test posthog_tracking --test posthog_lossless -- --nocapture
cargo test --locked --offline --no-default-features --features posthog-benchmark --test posthog_tracking -- --ignored --nocapture
cargo test --release --locked --offline --no-default-features --features posthog-benchmark --test posthog_tracking_benchmark -- --ignored --exact prepared_payload_benchmark --nocapture
sha256sum "$wave/benchmark/input.json" "$wave/benchmark/node-report.json" > "$wave/focused-inputs-after.sha256"
cmp "$wave/focused-inputs-before.sha256" "$wave/focused-inputs-after.sha256"
