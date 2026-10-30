#!/bin/sh
set -eu
cd /source/dimabot
export TZ=UTC
export DIMA_SETTINGS_STORE_FIXTURE_DIR=/artifacts/moderation-settings-store/attempt5/reference
export DIMA_SETTINGS_STORE_FIXTURE_SHA256="$(python3 -c 'import hashlib,os; print(hashlib.sha256(open(os.environ["DIMA_SETTINGS_STORE_FIXTURE_DIR"]+"/moderation-settings-store-reference.json","rb").read()).hexdigest())')"
export DIMA_VARIATION_JOBS_FAILPOINT_OWNER="$KEYWORD_FIXTURE_NAMESPACE"
cargo test --locked --offline --no-default-features --features moderation-settings-store --test moderation_settings_store
cargo test --locked --offline --no-default-features --features moderation-settings-store --test moderation_settings_store -- --ignored --nocapture --test-threads=1
cargo fmt --all -- --check
cargo clippy --locked --offline --no-default-features --features moderation-settings-store --all-targets -- -D warnings
cargo check --locked --offline --no-default-features --all-targets
cargo clippy --locked --offline --all-features --all-targets -- -D warnings
