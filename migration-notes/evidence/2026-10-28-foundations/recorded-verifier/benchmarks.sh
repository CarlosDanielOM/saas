set -eu
FEATURES=application-schemas,domain-event-runtime,keyword-store
APPLICATION_SCHEMAS_BENCHMARK_OUTPUT=/artifacts/application-schemas-rust.json cargo test --locked --offline --release --no-default-features --features "$FEATURES" --test application_schemas benchmark_application_schemas -- --ignored --nocapture
cargo build --locked --offline --release --no-default-features --features "$FEATURES" --test domain_event_runtime --example keyword_native_benchmark
DOMAIN_JOURNAL_BENCH_ITERATIONS=1000 cargo test --locked --offline --release --no-default-features --features "$FEATURES" --test domain_event_runtime domain_event_durable_journal_benchmark -- --ignored --nocapture
KEYWORD_BENCH_ITERATIONS=100 KEYWORD_BENCH_SAMPLES=7 cargo run --locked --offline --release --no-default-features --features "$FEATURES" --example keyword_native_benchmark > /artifacts/keyword-native-rust.json
