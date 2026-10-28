set -eu
FEATURES=observability,logger,domain-event-runtime,tts-utilities,keyword-store,twitch-functions,bits-rules
cargo fmt --all -- --check
cargo check --locked --offline --all-targets --no-default-features --features "$FEATURES"
cargo clippy --locked --offline --all-targets --no-default-features --features "$FEATURES" -- -D warnings
cargo test --locked --offline --no-default-features --features "$FEATURES" --lib
cargo test --locked --offline --no-default-features --features "$FEATURES" --test bits_rules --test native_telemetry --test tts_utilities --test domain_event_runtime --test twitch_functions --test keyword_native_adapters --no-fail-fast
cargo test --locked --offline --no-default-features --features "$FEATURES" --test native_telemetry redis_inbox_batch_overflow_and_expiry -- --ignored --nocapture
cargo test --locked --offline --no-default-features --features "$FEATURES" --test domain_event_runtime native_journal_races_owner_resolution_durability_wakeups_and_telemetry -- --ignored --nocapture
cargo test --locked --offline --no-default-features --features "$FEATURES" --test bits_rules -- --ignored --nocapture
