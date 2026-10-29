set -eu
export TZ=UTC
wave=/artifacts/posthog-payload-performance/attempt3
find "$wave" -name '*.json' -type f -exec sha256sum {} \; | sort > "$wave/other-fixtures-before.sha256"
cargo test --locked --offline --all-features --test schema_core_contracts --test application_schemas --test additional_schemas --test domain_contracts --test keyword_native_hydration -- --nocapture
for pair in UTC:UTC America/New_York:America_New_York Europe/Berlin:Europe_Berlin Australia/Lord_Howe:Australia_Lord_Howe Pacific/Apia:Pacific_Apia; do
  TZ="${pair%%:*}" MONGOOSE_DATE_FIXTURE="$wave/mongoose-date/${pair#*:}.json" cargo test --locked --offline --all-features --test mongoose_date mongoose_source_corpus_and_shared_schema -- --exact --nocapture
done
find "$wave" -name '*.json' -type f -exec sha256sum {} \; | sort > "$wave/other-fixtures-after.sha256"
cmp "$wave/other-fixtures-before.sha256" "$wave/other-fixtures-after.sha256"
