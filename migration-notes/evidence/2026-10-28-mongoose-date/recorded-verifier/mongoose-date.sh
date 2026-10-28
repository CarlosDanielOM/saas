set -eu
cargo fmt --all -- --check
sha256sum /artifacts/mongoose-date/*.json > /artifacts/mongoose-date-fixtures-before.sha256
for zone in UTC America/New_York Europe/Berlin Australia/Lord_Howe Pacific/Apia; do
  file=$(printf '%s' "$zone" | tr / _)
  TZ="$zone" MONGOOSE_DATE_FIXTURE="/artifacts/mongoose-date/$file.json" cargo test --locked --offline --no-default-features --features application-schemas --test mongoose_date mongoose_source_corpus_and_shared_schema -- --exact --nocapture
done
TZ=UTC cargo test --locked --offline --no-default-features --features application-schemas --test application_schemas --test additional_schemas --lib
TZ=UTC cargo test --locked --offline --no-default-features --features application-schemas --test mongoose_date mongoose_date_admin_repository_persistence -- --ignored --exact --nocapture
TZ=UTC cargo test --locked --offline --no-default-features --features application-schemas --test application_schemas native_schema_persistence_indexes_and_hooks -- --ignored --exact --nocapture
TZ=UTC cargo test --locked --offline --no-default-features --features application-schemas --test additional_schemas additional_schema_native_indexes_conditions_immutability_and_maps -- --ignored --exact --nocapture
cargo check --locked --offline --all-targets --no-default-features --features application-schemas
cargo clippy --locked --offline --all-targets --no-default-features --features application-schemas -- -D warnings
cargo check --locked --offline --keep-going --all-targets --all-features
cargo clippy --locked --offline --keep-going --all-targets --all-features -- -D warnings
cargo check --locked --offline --all-targets --no-default-features
for workload in numeric string invalid mixed; do
  TZ=UTC MONGOOSE_DATE_FIXTURE=/artifacts/mongoose-date/UTC.json MONGOOSE_DATE_BENCH_WORKLOAD="$workload" MONGOOSE_DATE_BENCH_OUTPUT="/artifacts/mongoose-date-rust-$workload.json" cargo test --release --locked --offline --no-default-features --features application-schemas --test mongoose_date mongoose_date_benchmark -- --ignored --exact --nocapture
done
sha256sum /artifacts/mongoose-date/*.json > /artifacts/mongoose-date-fixtures-after.sha256
cmp /artifacts/mongoose-date-fixtures-before.sha256 /artifacts/mongoose-date-fixtures-after.sha256
