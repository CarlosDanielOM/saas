set -eu
cargo test --locked --offline --no-default-features --features moderation-permit --lib utils::moderation::permit::tests::read_tasks_keep_parent_telemetry_context -- --exact --nocapture
