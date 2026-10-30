set -eu
cargo fmt --all -- --check
. /task-tools/decision_model_env2.sh
sh /task-tools/decision_model_pure2.sh
export DIMA_DECISION_SCHEMA_MONGO_URI="$KEYWORD_FIXTURE_MONGO_URI"
decision_owner=${KEYWORD_FIXTURE_NAMESPACE#keyword-fixture-}
decision_owner=${decision_owner%:}
export DIMA_DECISION_SCHEMA_OWNER="$decision_owner"
export DIMA_DECISION_SCHEMA_DATABASE="rust_decision_fixture_$decision_owner"
cargo test --locked --offline --no-default-features --features moderation-decision-schema --test moderation_decision_schema mongo_crud_and_indexes -- --ignored --exact --nocapture
cargo test --locked --offline --no-default-features --features moderation-decision-schema,channel-tts-settings --test application_schemas --test additional_schemas --test schema_composite_defaults --test channel_moderation_settings_schema --test channel_tts_settings_schema
cargo test --locked --offline --no-default-features --features application-schemas --test application_schemas native_schema_persistence_indexes_and_hooks -- --ignored --exact --nocapture
cargo test --locked --offline --no-default-features --features application-schemas --test additional_schemas additional_schema_native_indexes_conditions_immutability_and_maps -- --ignored --exact --nocapture
. /task-tools/variation_jobs_runtime2.sh
cargo clippy --locked --offline --no-default-features --features moderation-decision-schema --all-targets --keep-going -- -D warnings
cargo check --locked --offline --no-default-features --all-targets
cargo check --locked --offline --no-default-features --features mongo,redis --all-targets
cargo clippy --locked --offline --all-features --all-targets --keep-going -- -D warnings
