#!/bin/sh
# Run only inside the capped, isolated compiler workflow with the attempt-4
# oracle fixture mounted under /artifacts and a pinned external Node oracle.
set -eu
: "${DIMA_VARIATION_SCHEMA_FIXTURE_SHA256:?set the final fixture SHA-256}"
: "${DIMA_VARIATION_SCHEMA_FIXTURE_DIR:?set the mounted reference directory}"
export DIMA_VARIATION_SCHEMA_FIXTURE_DIR
export DIMA_VARIATION_SCHEMA_FIXTURE_SHA256
cargo test --locked --test moderation_variation_schema replay_actual_mongoose_source -- --ignored --exact
