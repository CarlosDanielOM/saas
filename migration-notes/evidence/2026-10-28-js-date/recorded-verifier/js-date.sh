set -eu
cargo fmt --all -- --check
status=0
for zone in UTC America/New_York Europe/Berlin Australia/Lord_Howe Pacific/Apia; do
  TZ="$zone" cargo test --locked --offline --no-default-features --features js-date --test js_date -- --nocapture || status=1
done
test "$status" = 0
TZ=UTC cargo test --locked --offline --no-default-features --features domain-events --test domain_contracts --lib
TZ=UTC cargo test --locked --offline --no-default-features --features domain-event-runtime --test domain_event_runtime
cargo check --locked --offline --all-targets --no-default-features --features js-date
cargo clippy --locked --offline --all-targets --no-default-features --features js-date -- -D warnings
cargo check --locked --offline --keep-going --all-targets --all-features
cargo clippy --locked --offline --keep-going --all-targets --all-features -- -D warnings
cargo check --locked --offline --all-targets --no-default-features
for workload in iso legacy invalid mixed; do
  TZ=UTC JS_DATE_BENCH_WORKLOAD="$workload" JS_DATE_BENCH_OUTPUT="/artifacts/js-date-rust-$workload.json" cargo test --release --locked --offline --no-default-features --features js-date --test js_date benchmark_date_parse -- --ignored --exact --nocapture
done
