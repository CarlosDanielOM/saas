set -eu
wave=/artifacts/posthog-payload-performance/attempt3
export POSTHOG_TRACKING_FIXTURES="$wave/tracking"
export POSTHOG_LOSSLESS_REFERENCE_DIR="$wave/transport"
export DIMA_JSON_NUMBER_REFERENCE_DIR="$wave/numbers"
export POSTHOG_BENCH_DIR="$wave/benchmark"
export POSTHOG_BENCH_INPUT_SHA256=bd4d96286803589f2771115afce87fcbdc175df69f1c77866c1a7f306ac771f1
sha256sum "$wave/benchmark/input.json" "$wave/benchmark/node-report.json" > "$wave/focused-inputs-before.sha256"
cargo test --locked --offline --no-default-features --features posthog-benchmark --lib --test posthog_tracking --test posthog_lossless --test json_number_parity -- --nocapture
cargo test --locked --offline --no-default-features --features posthog-benchmark --test posthog_tracking -- --ignored --nocapture
cargo test --locked --offline --no-default-features --features posthog-benchmark --test json_number_parity replay_every_binary64_engine_wire -- --ignored --exact --nocapture
cargo test --release --locked --offline --no-default-features --features posthog-benchmark --test posthog_tracking_benchmark -- --ignored --exact prepared_payload_benchmark --nocapture
sha256sum "$wave/benchmark/input.json" "$wave/benchmark/node-report.json" > "$wave/focused-inputs-after.sha256"
cmp "$wave/focused-inputs-before.sha256" "$wave/focused-inputs-after.sha256"
