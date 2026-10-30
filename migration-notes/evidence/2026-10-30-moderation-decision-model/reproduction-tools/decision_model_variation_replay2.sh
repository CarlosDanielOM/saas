set -eu
export DIMA_VARIATION_SCHEMA_FIXTURE_DIR=/artifacts/moderation-decision-model/attempt2/variation-schema
export DIMA_VARIATION_SCHEMA_FIXTURE_SHA256=281d5d33b6f5a905c42ed8f107a11eb10dba3a4088c7d88fd8f83ad9234fbc1b
cargo test --locked --offline --no-default-features --features moderation-variation-storage --test moderation_variation_schema --test schema_composite_defaults
cargo test --locked --offline --no-default-features --features moderation-variation-storage --test moderation_variation_schema replay_actual_mongoose_source -- --ignored --exact --nocapture
