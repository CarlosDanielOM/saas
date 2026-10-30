set -eu
export DIMA_RULE_DISPATCHER_FIXTURE_DIR=/artifacts/moderation-rule-dispatcher/attempt1/reference
export DIMA_RULE_DISPATCHER_FIXTURE_SHA256=bcd9ffc9be201032c500e465f8443ae5f5abc9a57d7b95e9dd62909b924fddc6
cargo test --locked --offline --no-default-features --features moderation-rules --test moderation_rule_dispatcher -- --ignored --nocapture
cargo check --locked --offline --no-default-features --all-targets
cargo check --locked --offline --no-default-features --features mongo,redis --all-targets
cargo clippy --locked --offline --all-features --all-targets -- -D warnings
