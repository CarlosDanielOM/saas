#!/bin/sh
set -eu
cd /source/dimabot
export TZ=UTC
base=/artifacts/schema-named-retirement/attempt1
export SCHEMA_NAMED_TYPES_FIXTURE="$base/named/schema-named-types-reference.json"
export SCHEMA_NAMED_TYPES_SHA256="$(python3 -c 'import hashlib,os; print(hashlib.sha256(open(os.environ["SCHEMA_NAMED_TYPES_FIXTURE"],"rb").read()).hexdigest())')"
export DIMA_APPLICATION_SCHEMAS_FIXTURE_DIR="$base/application"
export DIMA_APPLICATION_SCHEMAS_FIXTURE_SHA256="$(python3 -c 'import hashlib,os; print(hashlib.sha256(open(os.environ["DIMA_APPLICATION_SCHEMAS_FIXTURE_DIR"]+"/application-schemas-reference.json","rb").read()).hexdigest())')"
export DIMA_ACTION_LOG_SCHEMA_FIXTURE_DIR="$base/action"
export DIMA_ACTION_LOG_SCHEMA_FIXTURE_SHA256="$(python3 -c 'import hashlib,os; print(hashlib.sha256(open(os.environ["DIMA_ACTION_LOG_SCHEMA_FIXTURE_DIR"]+"/moderation-action-log-schema-reference.json","rb").read()).hexdigest())')"
cargo fmt --all -- --check
cargo test --locked --offline --no-default-features --features moderation-action-log-schema --test schema_named_types --test application_schemas --test moderation_action_log_schema
cargo test --locked --offline --no-default-features --features application-schemas --test schema_named_types source_oracle_and_catalogs -- --ignored --exact
cargo test --locked --offline --no-default-features --features moderation-action-log-schema --test moderation_action_log_schema replay_actual_mongoose_source -- --ignored --exact
for zone in UTC America/New_York Europe/Berlin Australia/Lord_Howe Pacific/Apia; do
  file=$(printf '%s' "$zone" | tr / _)
  TZ="$zone" MONGOOSE_DATE_FIXTURE="$base/date/$file.json" cargo test --locked --offline --no-default-features --features application-schemas --test mongoose_date mongoose_source_corpus_and_shared_schema -- --exact
 done
cargo clippy --locked --offline --no-default-features --features moderation-action-log-schema --all-targets -- -D warnings
cargo check --locked --offline --no-default-features --all-targets
cargo clippy --locked --offline --all-features --all-targets -- -D warnings
