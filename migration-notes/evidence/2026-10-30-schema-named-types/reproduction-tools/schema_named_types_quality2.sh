#!/bin/sh
set -eu
cd /source/dimabot
export TZ=UTC
base=/artifacts/schema-named-types/attempt2
export SCHEMA_NAMED_TYPES_FIXTURE="$base/named/schema-named-types-reference.json"
export SCHEMA_NAMED_TYPES_SHA256="$(python3 -c 'import hashlib,os; print(hashlib.sha256(open(os.environ["SCHEMA_NAMED_TYPES_FIXTURE"],"rb").read()).hexdigest())')"
export DIMA_APPLICATION_SCHEMAS_FIXTURE_DIR="$base/application"
export DIMA_APPLICATION_SCHEMAS_FIXTURE_SHA256="$(python3 -c 'import hashlib,os; print(hashlib.sha256(open(os.environ["DIMA_APPLICATION_SCHEMAS_FIXTURE_DIR"]+"/application-schemas-reference.json","rb").read()).hexdigest())')"
cargo fmt --all -- --check
cargo test --locked --offline --no-default-features --features application-schemas --test schema_named_types --test application_schemas
cargo test --locked --offline --no-default-features --features application-schemas --test schema_named_types source_oracle_and_catalogs -- --ignored --exact
cargo clippy --locked --offline --no-default-features --features application-schemas --all-targets -- -D warnings
cargo check --locked --offline --no-default-features --all-targets
cargo check --locked --offline --no-default-features --features mongo,redis --all-targets
cargo clippy --locked --offline --all-features --all-targets -- -D warnings
