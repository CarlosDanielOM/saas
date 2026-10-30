set -eu
cargo fmt --all -- --check
cargo test --locked --offline --no-default-features --features moderation-variation-storage --test moderation_variation_schema --test application_schemas --test additional_schemas --test schema_composite_defaults
DIMA_VARIATION_SCHEMA_FIXTURE_DIR=/artifacts/moderation-variation-schema/attempt4/reference DIMA_VARIATION_SCHEMA_FIXTURE_SHA256=6afcb081ec891116bc63cc3d1f8ce2e9e00876fc082c9533df07fe3e05f1d870 cargo test --locked --offline --no-default-features --features moderation-variation-storage --test moderation_variation_schema replay_actual_mongoose_source -- --ignored --exact --nocapture
export DIMA_VARIATION_SCHEMA_MONGO_URI=mongodb://keyword-mongo:27017
export DIMA_VARIATION_SCHEMA_OWNER=varSchema20261030
export DIMA_VARIATION_SCHEMA_DATABASE=rust_variation_fixture_varSchema20261030
cargo test --locked --offline --no-default-features --features moderation-variation-storage --test moderation_variation_schema mongo_crud_and_indexes -- --ignored --exact --nocapture
cargo clippy --locked --offline --no-default-features --features moderation-variation-storage --all-targets --keep-going -- -D warnings
cargo check --locked --offline --no-default-features --all-targets
cargo check --locked --offline --no-default-features --features mongo,redis --all-targets
cargo clippy --locked --offline --all-features --all-targets --keep-going -- -D warnings
